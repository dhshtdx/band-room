const sourceLink = document.querySelector('#source-link');

try {
  const response = await fetch('/release-info.json', { cache: 'no-store' });
  const release = await response.json();
  if (release.sourceUrl) {
    sourceLink.href = release.sourceUrl;
    sourceLink.classList.remove('hidden');
  }
} catch {
  // 法律文本仍可离线阅读；正式构建预检会阻止缺少源码地址的发行。
}
