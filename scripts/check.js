const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const ignoreDirs = new Set(['node_modules', '.git', 'data']);

function collectJsFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) {
        continue;
      }

      files.push(...collectJsFiles(path.join(directory, entry.name)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(directory, entry.name));
    }
  }

  return files;
}

const files = collectJsFiles(projectRoot);

for (const filePath of files) {
  execFileSync(process.execPath, ['--check', filePath], { stdio: 'inherit' });
}

const { createDatabase } = require(path.join(projectRoot, 'src', 'db', 'database'));
const tempDatabasePath = path.join(os.tmpdir(), `otaku-assistant-check-${process.pid}.db`);
const database = createDatabase(tempDatabasePath);
database.sqlite.close();
fs.rmSync(tempDatabasePath, { force: true });
fs.rmSync(`${tempDatabasePath}-shm`, { force: true });
fs.rmSync(`${tempDatabasePath}-wal`, { force: true });

console.log(`Checked ${files.length} JavaScript files.`);
