/**
 * Puppeteer config for the Railway build.
 * Chrome/Chromium is only needed for the local tips.gg scraper — the hosted
 * backend never launches a browser, so skip the download entirely.
 */
module.exports = {
  skipDownload: true,
};
