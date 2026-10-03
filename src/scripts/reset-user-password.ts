import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { hashPassword } from '../shared/utils/jwt.js';

const email = (process.argv[2] || 'admin@editco.com').toLowerCase();
const password = process.argv[3] || 'Admin@123456';

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const hash = await hashPassword(password);
  const result = await mongoose.connection.db!.collection('users').updateOne({ email }, { $set: { password: hash } });
  if (!result.matchedCount) throw new Error(`User not found: ${email}`);
  console.log(`Password reset for ${email}`);
  console.log(`Password: ${password}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
