import fs from 'fs';

let content = fs.readFileSync('server.ts', 'utf8');

// Replace __filename and __dirname with safe fallbacks
content = content.replace(
  /const __filename = fileURLToPath\(import\.meta\.url\);\nconst __dirname = path\.dirname\(__filename\);/g,
  `const __filename = typeof __filename !== 'undefined' ? __filename : fileURLToPath((typeof import.meta !== 'undefined' && import.meta.url) ? import.meta.url : 'file://' + process.cwd() + '/server.ts');\nconst __dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(__filename);`
);

fs.writeFileSync('server.ts', content);
console.log('Fixed server.ts');
