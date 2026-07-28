import { createExpressApp } from '../server.ts';

let appPromise: any = null;

export default async function handler(req: any, res: any) {
  if (!appPromise) {
    appPromise = createExpressApp();
  }
  const app = await appPromise;
  return app(req, res);
}
