const fs = require('fs');
const path = require('path');

const owner = 'ornate-source';
const repo = 'blackIDE';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

async function run() {
  const headers = {};
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  console.log(`Fetching latest release from ${url}...`);
  
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch release: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  const tag_name = data.tag_name;
  
  // Clean up and keep only necessary fields
  const assets = data.assets.map(asset => ({
    name: asset.name,
    browser_download_url: asset.browser_download_url,
    size: asset.size
  }));
  
  const releaseData = {
    tag_name: tag_name,
    assets: assets
  };
  
  const outputFilePath = path.join(__dirname, '../../web/releases.js');
  const outputContent = `// Static release assets data source to prevent GitHub API rate limit issues
window.LATEST_RELEASE = ${JSON.stringify(releaseData, null, 2)};
`;

  fs.writeFileSync(outputFilePath, outputContent);
  console.log(`Successfully updated ${outputFilePath} with tag ${tag_name} and ${assets.length} assets.`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
