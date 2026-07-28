import fs from 'fs';
import path from 'path';

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      if (!file.includes('node_modules') && !file.includes('dist')) {
        results = results.concat(walk(file));
      }
    } else { 
      if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.mjs')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walk('.');

let changed = 0;
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  // Match import and export statements ending in .ts
  const newContent = content.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2')
                            .replace(/(import\s*\(['"][^'"]+)\.ts(['"]\))/g, '$1.js$2');
  
  if (content !== newContent) {
    fs.writeFileSync(file, newContent);
    console.log('Updated imports in', file);
    changed++;
  }
});

console.log('Fixed', changed, 'files.');
