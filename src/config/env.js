for (const k of ['MONGODB_URI','JWT_SECRET']) if (!process.env[k]) { console.error('Missing env '+k); process.exit(1); }
