import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

function git(...args) {
    execFileSync('git', args, { cwd: dist, stdio: 'inherit' });
}

// Get the remote URL from the project repo so auth (SSH/credential manager) carries over
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
}).trim();

// Fresh git repo in dist — avoids gh-pages' "git rm --cached file1 file2 ..." pattern
// that blows past Windows's CreateProcess argument-length limit (ENAMETOOLONG).
if (existsSync(resolve(dist, '.git'))) {
    rmSync(resolve(dist, '.git'), { recursive: true, force: true });
}

git('init', '-b', 'gh-pages');
git('add', '-A');           // -A never lists files individually — no length issue
git('commit', '-m', 'Deploy');
git('remote', 'add', 'origin', remote);
git('push', '--force', 'origin', 'gh-pages');

console.log('\nDeployed to gh-pages branch.');
