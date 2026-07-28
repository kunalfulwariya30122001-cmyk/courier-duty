import { createExpressApp } from '../server.ts';

let appPromise: any = null;

export default async function handler(req: any, res: any) {
  try {
    if (!appPromise) {
      appPromise = createExpressApp();
    }
    const app = await appPromise;
    return app(req, res);
  } catch (err: any) {
    console.error('VERCEL CRASH ERROR:', err);
    return res.status(500).json({
      error: 'Function crashed during initialization',
      message: err.message,
      stack: err.stack,
    });
  }
}
