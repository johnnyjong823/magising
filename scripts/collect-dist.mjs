// PKG-1 / PKG-9：把 Tauri 產生的 NSIS 安裝檔複製到專案根目錄的 dist/，改成「MagiSing_Setup_x.y.z.exe」（公開下載用英文檔名，網址不會變成一串 %XX）
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..');
const { version } = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
const nsisDir = join(src, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const exe = readdirSync(nsisDir)
  .filter((f) => f.endsWith('-setup.exe') && f.includes(version))
  .map((f) => join(nsisDir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!exe) {
  console.error(`找不到 ${version} 的安裝檔（${nsisDir}）`);
  process.exit(1);
}
// CI 用 DIST_DIR 指定輸出位置（GitHub Actions 不方便上傳 repo 外面的檔案）
const outDir = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(src, '..', 'dist');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `MagiSing_Setup_${version}.exe`);
copyFileSync(exe, out);
console.log(`✔ ${out}（${(statSync(out).size / 1024 / 1024).toFixed(1)} MB）`);
