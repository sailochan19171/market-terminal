// Liveness for the hosting platform: answers without touching the database.
export const GET = () => Response.json({ ok: true, time: new Date().toISOString() });
