import type { Request, Response } from 'express';
import { loadFromFirestore, firestoreStatus, lastDbError, rawRowsLoaded } from '../server/db.js';

export default async function handler(req: Request, res: Response) {
  try {
    await loadFromFirestore();
    res.status(200).json({
      status: firestoreStatus,
      error: lastDbError,
      rawLoaded: rawRowsLoaded
    });
  } catch (err: any) {
    res.status(200).json({
      status: firestoreStatus || "Data not loaded",
      error: err.message || String(err),
      rawLoaded: false
    });
  }
}
