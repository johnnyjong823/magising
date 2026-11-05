// 產生 src-tauri/THIRD-PARTY-NOTICES.txt（開源元件授權聲明，隨安裝檔一起散布）
// 用法：npm run notices（需要 cargo-about：cargo install cargo-about --locked --features cli）
// 加減 Rust 或 npm 套件之後要重跑一次
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(root, 'src-tauri');
const out = join(tauriDir, 'THIRD-PARTY-NOTICES.txt');
const rule = '='.repeat(78);
const thin = '-'.repeat(78);
const parts = [];

parts.push(`魔唱 MagiSing — 第三方元件授權聲明 / Third-Party Notices
${rule}
魔唱本身以 GPL-3.0-or-later 授權開源（https://github.com/johnnyjong823/magising），並使用了下列開源元件。各元件的著作權屬於原作者，依其授權條款散布；
這份文件列出各元件的名稱、版本、來源與授權全文。
MagiSing includes the open-source components listed below. Each component is
copyright its respective authors and is distributed under the license shown.
`);

// ---------- 字型 ----------
parts.push(`${rule}
字型 / Font: Cubic 11（俐方體 11 號）
Source: https://github.com/ACh-K/Cubic-11
License: SIL Open Font License 1.1
${thin}
${readFileSync(join(root, 'web/shared/fonts/Cubic_11-OFL.txt'), 'utf8').trim()}
`);

// ---------- 打包進前端的 npm 套件（package.json 的 dependencies 以及它們的相依） ----------
// 照 Node 的規則從所在資料夾往上找 node_modules（巢狀的版本也找得到），以「名稱@版本」去重
// （不用 require.resolve：有 exports 欄位的套件不讓解析 package.json）
function findPkg(name, from) {
  for (let d = from; ; d = dirname(d)) {
    const p = join(d, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return p;
    if (dirname(d) === d) throw new Error(`找不到 ${name}（從 ${from}）`);
  }
}
const seen = new Set();
const queue = Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {}).map((name) => ({ name, from: root }));
const npmParts = [];
while (queue.length) {
  const { name, from } = queue.shift();
  const dir = findPkg(name, from);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (seen.has(`${pkg.name}@${pkg.version}`)) continue;
  seen.add(`${pkg.name}@${pkg.version}`);
  queue.push(...Object.keys(pkg.dependencies ?? {}).map((n) => ({ name: n, from: dir })));
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? pkg.homepage ?? '';
  const texts = licenseFiles(dir).map((f) => `[${f.slice(dir.length + 1).replaceAll('\\', '/')}]\n${readFileSync(f, 'utf8').trim()}`);
  npmParts.push(`${thin}
${pkg.name} ${pkg.version}
Source: ${repo.replace(/^git\+/, '')}
License: ${pkg.license}

${texts.join('\n\n') || '(套件沒有附授權檔，授權為 ' + pkg.license + ')'}
`);
}
parts.push(`${rule}
JavaScript 套件 / JavaScript packages
${npmParts.join('\n')}`);

function licenseFiles(dir) {
  const hit = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (/^licen[cs]es?$/i.test(f)) hit.push(...readdirSync(p).map((x) => join(p, x)).filter((x) => statSync(x).isFile()));
    } else if (/^(licen[cs]e|notice|copying|third_party_licen[cs]es)/i.test(f)) {
      hit.push(p);
    }
  }
  return hit;
}

// ---------- Rust crates（cargo-about） ----------
try {
  execFileSync('cargo', ['about', '--version'], { stdio: 'ignore' });
} catch {
  console.error('找不到 cargo-about，請先執行：cargo install cargo-about --locked --features cli');
  process.exit(1);
}
const rustTxt = join(root, 'notices', 'rust.txt');
execFileSync('cargo', ['about', 'generate', '-c', '../notices/about.toml', '../notices/about.hbs', '-o', rustTxt], { cwd: tauriDir, stdio: ['ignore', 'ignore', 'inherit'] });
parts.push(`${rule}
Rust 套件 / Rust crates
${readFileSync(rustTxt, 'utf8').trim()}
`);

// ---------- 其他隨安裝檔附帶的元件 ----------
parts.push(`${rule}
其他 / Others
${thin}
Microsoft Edge WebView2 Runtime
魔唱使用系統的 WebView2 顯示畫面。電腦缺少 WebView2 時（只有部分 Windows 10），安裝檔會
從微軟官方網站下載安裝。WebView2 Runtime 為 Microsoft 的軟體，不包含在魔唱裡，依 Microsoft 的授權條款使用。
MagiSing uses the system WebView2 runtime. If it is missing, the installer
downloads it from Microsoft. The runtime is Microsoft software, is not bundled
with MagiSing, and is licensed under Microsoft's terms: https://developer.microsoft.com/microsoft-edge/webview2/
${thin}
NSIS (Nullsoft Scriptable Install System)
The installer is built with NSIS, licensed under the zlib/libpng license.
https://nsis.sourceforge.io/License
`);

writeFileSync(out, '\uFEFF' + parts.join('\n').replace(/\r?\n/g, '\r\n'));
console.log(`✔ ${out}（npm ${seen.size} 個套件、${(statSync(out).size / 1024).toFixed(0)} KB）`);
