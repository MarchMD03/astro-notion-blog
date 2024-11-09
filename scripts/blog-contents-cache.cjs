const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const { Client } = require('@notionhq/client');
const cliProgress = require('cli-progress');
const { PromisePool } = require('@supercharge/promise-pool');

const notion = new Client({ auth: process.env.NOTION_API_SECRET });
const S3 = new S3Client({
  region: 'auto',
  endpoint: process.env.ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Cloudflare R2にデータをアップロード
 * 
 * @param {string} key - アップロードするファイルのキー（ファイル名）
 * @param {Buffer} data - アップロードするデータのバッファ
 */
const uploadFileS3 = async (key, data) => {
  const command = new PutObjectCommand({
    Body: data,
    Bucket: process.env.ASTRO_NOTION_BLOG_CACHE_BUCKET,
    Key: key,
    ContentType: 'application/json',
  })

  try {
    await S3.send(command);
    console.log("[データをアップロード]", key);
  } catch (err) {
    console.error(err);
  }
};

/**
 * Cloudflare R2にデータを取得（すべて）
 * 
 * @returns {Promise<{Contents: Array}>} - 取得したデータの配列を含むオブジェクト
 */
const getAllDataS3 = async () => {
  let isTruncated = true; // ページネーションの継続フラグ
  let continuationToken = null; // ページネーションのトークン
  const allContents = []; // 取得したデータ

  while (isTruncated) {
    // ページネーションのトークンを指定したリクエスト（一度の1000件までしか取得できないので続きを取得するために必要）
    const command = new ListObjectsV2Command({
      Bucket: process.env.ASTRO_NOTION_BLOG_CACHE_BUCKET,
      Prefix: '',
      ContinuationToken: continuationToken,
    });

    try {
      // データを取得
      const response = await S3.send(command);
      allContents.push(...response.Contents);

      // ページネーションの継続フラグを更新
      isTruncated = response.IsTruncated;
      continuationToken = response.NextContinuationToken;
    } catch (err) {
      console.error(err);
      break;
    }
  }

  return { Contents: allContents };
}

/**
 * Cloudflare R2からデータを取得
 * 
 * @param {string} key - 取得するファイルのキー（ファイル名）
 * @returns {Promise<{Body: ReadableStream}>} - 取得したデータのレスポンス
 */
const getDataS3 = async (key) => {
  const command = new GetObjectCommand({
    Bucket: process.env.ASTRO_NOTION_BLOG_CACHE_BUCKET,
    Key: key,
  });

  try {
    const response = await S3.send(command);
    return response;
  } catch (err) {
    console.error(err);
  }
}

/**
 * Cloudflare R2からデータをダウンロード
 * 
 * @param {string} key - ダウンロードするファイルのキー（ファイル名）
 * @param {string} path - ダウンロードしたファイルを保存するローカルパス
 */
const downloadFileS3 = async (key, path) => {
  try {
    const response = await getDataS3(key);
    const data = await response.Body.transformToByteArray();
    
    fs.writeFileSync(path, data);
  } catch (err) {
    console.error(err);
  }
}

/**
 * Cloudflare R2からすべてのデータをダウンロード
 * 
 * @returns {Promise<Array>} - ダウンロードしたデータの配列
 */
const downloadAllFilesS3 = async () => {
  const objects = await getAllDataS3();
  const contents = objects.Contents;

  if (!contents || contents.length === 0) {
    console.log("[データをすべてダウンロード]0件ダウンロードしました");
    return [];
  }

  const progressBar = new cliProgress.SingleBar(
    { stopOnComplete: true },
    cliProgress.Presets.shades_classic
  );
  progressBar.start(contents.length, 0);

  const downloadedData = [];
  let downloadCount = 0;

  await PromisePool.withConcurrency(1)
    .for(contents)
    .process(async (content) => {
      return new Promise(async (resolve) => {
        const key = content.Key;
        const filePath = `tmp/${key}.json`;

        // ファイルが既に存在するかチェック
        if (!fs.existsSync(filePath)) {
          await downloadFileS3(key, filePath);
          downloadCount++; // ダウンロードした件数をカウント
        }

        const fileData = await fs.promises.readFile(filePath, 'utf-8');
        downloadedData.push(JSON.parse(fileData));
        progressBar.increment();
        return resolve();
      });
    });

  console.log("[データをすべてダウンロード]", downloadCount, "件ダウンロードしました");
  return downloadedData;
}

/**
 * キャッシュを保存
 * 
 * @param {string} blockId - キャッシュするブロックのID
 * @param {Object} block - キャッシュするブロックのデータ
 */
const saveCache = async (blockId, block) => {
    // ファイルを保存
    fs.writeFileSync(`tmp/${blockId}.json`, JSON.stringify(block));

    // Cloudflare R2にアップロード
    await uploadFileS3(`${blockId}`, JSON.stringify(block));
}  

/**
 * Notion からページを取得
 * 
 * @param {Object} queue - リクエストを制限するためのキューオブジェクト
 * @returns {Promise<Array>} - 取得したページの配列
 */
const getAllPages = async (queue) => {
  const params = {
    database_id: process.env.DATABASE_ID,
    filter: {
      and: [
        {
          property: 'Published',
          checkbox: {
            equals: true,
          },
        },
        {
          property: 'Date',
          date: {
            on_or_before: new Date().toISOString(),
          },
        },
      ],
    },
  };

  let results = [];
  while (true) {
    const res = await retry(3, () => queue.add(() => notion.databases.query(params)));

    results = results.concat(res.results);

    if (!res.has_more) {
      break;
    }

    params['start_cursor'] = res.next_cursor;
  }

  const pages = results.map((result) => {
    return {
      id: result.id,
      last_edited_time: result.last_edited_time,
      slug: result.properties.Slug.rich_text
        ? result.properties.Slug.rich_text[0].plain_text
        : '',
    };
  });

  return pages;
};

/**
 * リトライ処理
 * 
 * @param {number} maxRetries - 最大リトライ回数
 * @param {Function} fn - リトライする関数
 * @returns {Promise} - リトライ結果のプロミス
 */
const retry = (maxRetries, fn) => {
  return fn().catch(function (err) {
    if (maxRetries <= 0) {
      console.error("最大リトライ回数を超えました:", err);
      return null;
    }
    return retry(maxRetries - 1, fn);
  });
};

/**
 * Notionブロックを再帰的に取得し、ローカルtmpに保存、リモートCloudflare R2にアップロード
 * 
 * @param {string} blockId - ブロックのID
 * @param {Object} queue - リクエストを制限するためのキューオブジェクト
 * @returns {Promise} - ブロックの再帰的取得結果のプロミス
 */
const retrieveAndWriteBlockChildren = async (blockId, queue) => {
  const params = { block_id: blockId };

  let results = [];

  while (true) {
    // ブロックの子要素を取得
    const res = await retry(3, () => queue.add(() => notion.blocks.children.list(params)));
    if (!res) {
      console.error("リトライ回数を超えました");
      return;
    }

    results = results.concat(res.results);

    // ブロックの子要素がない場合は終了
    if (!res.has_more) {
      break;
    }

    // ページネーションのトークンを更新（一度に100ブロックまでしか取得できないので続きを取得するために必要）
    params['start_cursor'] = res.next_cursor;
  }

  // キャッシュを保存
  saveCache(blockId, results);

  // ブロックの子要素を再帰的に取得
  results.forEach(async (block) => {
    if (
      block.type === 'synced_block' && // 同期されたブロック
      block.synced_block.synced_from && // 同期元のブロックが存在する
      block.synced_block.synced_from.block_id // 同期元のブロックIDが存在する
    ) {
      try {
        // 同期元のブロックを再帰的に取得
        await retrieveAndWriteBlock(block.synced_block.synced_from.block_id, queue);
      } catch (err) {
        console.log(
          `Could not retrieve the original synced_block. error: ${err}`
        );
        throw err;
      }
    } else if (block.has_children) {
      // ブロックの子要素がある場合は再帰的に取得
      await retrieveAndWriteBlockChildren(block.id, queue);
    }
  });
};

/**
 * ブロックを再帰的に取得
 * 
 * @param {string} blockId - ブロックのID
 * @param {Object} queue - リクエストを制限するためのキューオブジェクト
 */
const retrieveAndWriteBlock = async (blockId, queue) => {
  const params = { block_id: blockId };

  // ブロックを取得
  const block = await retry(3, () => queue.add(() => notion.blocks.retrieve(params)));

  if (!block) {
    console.error("リトライ回数を超えました");
    return;
  }

  // キャッシュを保存
  saveCache(blockId, block);

  // ブロックの子要素がある場合は再帰的に取得
  if (block.has_children) {
    await retrieveAndWriteBlockChildren(block.id, queue);
  }
};


(async () => {
  // For Notion API Requests limits
  // See https://developers.notion.com/reference/request-limits
  const queue = new (await import('p-queue')).default({ interval: 1000, intervalCap: 3 }) // Notion APIを1秒に3回までに制限

  // -----------------------------------------------------
  // 1. Cloudflare R2 からキャッシュしておいたNotionページを取得
  // -----------------------------------------------------
  const cachePages = await downloadAllFilesS3();

  // -----------------------------------------------------
  // 2. Notion からページを取得
  // -----------------------------------------------------
  const pages = await getAllPages(queue);

  // -----------------------------------------------------
  // 3. Notionページが更新されているかチェック
  // （更新があるページを抽出）
  // -----------------------------------------------------
  const updatedPages = pages.filter((page) => {
    const cachePage = cachePages.length > 0 ? cachePages.find((cachePage) => {
      return page.id === cachePage.id;
    }) : null;

    // キャッシュがない
    if (!cachePage) {
      return true;
    }

    return page.last_edited_time !== cachePage.last_edited_time;
  });
  // TODO；データが更新された場合に再キャッシュされるか確認

  // -----------------------------------------------------
  // 4. 更新があるページをキャッシュ
  // （Notionブロックを再帰的に取得し、ローカルtmpに保存、リモートCloudflare R2にアップロード）
  // -----------------------------------------------------
  const progressBar = new cliProgress.SingleBar(
    { stopOnComplete: true },
    cliProgress.Presets.shades_classic
  );
  
  if (updatedPages.length === 0) {
    progressBar.stop();
  } else {
    progressBar.start(updatedPages.length, 0);
    await PromisePool.withConcurrency(1)
      .for(updatedPages)
      .process(async (page) => {
        return new Promise(async (resolve) => {
          console.log("[ページのキャッシュを開始]:", page.slug);
          // キャッシュを保存
          await saveCache(page.slug, page); // ページ情報をキャッシュ（ファイル名をidにするとブロックのデータとファイル名が重複するので、ファイル名はスラッグにする。）
          await retrieveAndWriteBlockChildren(page.id, queue); // ページ内のブロック情報を再帰的にキャッシュ
          progressBar.increment();
          return resolve();
        });
      });
  }
})();
