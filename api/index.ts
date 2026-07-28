let appPromise: any = null;

export default async function handler(req: any, res: any) {
  try {
    if (!appPromise) {
      // Dynamically import to catch top-level initialization errors!
      const serverModule = await import('../server.ts');
      appPromise = serverModule.createExpressApp();
    }
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT_8S')), 8000);
    });

    const app = await Promise.race([appPromise, timeoutPromise]);
    return app(req, res);
  } catch (err: any) {
    console.error('VERCEL CRASH ERROR:', err);
    if (err.message === 'TIMEOUT_8S') {
      return res.status(504).json({ error: 'Initialization took more than 8 seconds! Vercel Timeout averted.' });
    }
    return res.status(500).json({
      error: `Initialization Crash: ${err.message} | Stack: ${err.stack}`,
      message: err.message,
    });
  }
}
