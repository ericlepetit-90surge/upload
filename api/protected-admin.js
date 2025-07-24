import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  res.status(200).send('<h1>It works!</h1>');
}
