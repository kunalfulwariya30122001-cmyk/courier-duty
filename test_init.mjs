import { createExpressApp } from './server.js';

async function test() {
  console.log('Starting...');
  try {
    const app = await createExpressApp();
    console.log('App created successfully!');
    process.exit(0);
  } catch (err) {
    console.error('App failed:', err);
    process.exit(1);
  }
}

test();
