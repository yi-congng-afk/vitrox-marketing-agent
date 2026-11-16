const { getImage } = require('./_shared/store-blobs');

// Serves one item/location photo. Every upload gets a new id, so the response
// can be cached by the browser indefinitely.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id || !/^img_[a-z0-9]+_[a-z0-9]*$/.test(id)) return { statusCode: 400, body: 'Bad image id' };

  const dataUrl = await getImage(id);
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  const header = comma > 0 ? /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64$/.exec(dataUrl.slice(0, comma)) : null;
  if (!header) return { statusCode: 404, body: 'Image not found' };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': header[1],
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
    body: dataUrl.slice(comma + 1),
    isBase64Encoded: true,
  };
};
