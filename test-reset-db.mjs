import dotenv from 'dotenv';
dotenv.config({ path: './.env' });
import { connectDb, User } from './server/db.js';

try {
  await connectDb();
  console.log('READY_STATE', (await import('mongoose')).default.connection.readyState);
  const user = await User.findOne({ email: 'sachin626425@gmail.com' });
  console.log('USER_EXISTS', !!user);
  console.log('USER_EMAIL', user?.email || null);
} catch (err) {
  console.error('ERR', err);
  process.exitCode = 1;
}
