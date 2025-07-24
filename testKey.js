import dotenv from 'dotenv';
dotenv.config();

console.log('Private key is multiline?', process.env.GOOGLE_PRIVATE_KEY.includes('\n'));
