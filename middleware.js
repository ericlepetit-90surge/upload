// middleware.js
import { NextResponse } from 'next/server';

const ADMIN_PASS = process.env.ADMIN_PASS || 'secret';
const DUMMY_USER = '90surge';

export function middleware(req) {
  const url = req.nextUrl;

  // Skip auth locally
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return NextResponse.next();
  }

  // Protect /admin or /public/admin.html
  if (url.pathname === '/admin' || url.pathname === '/public/admin.html') {
    const authHeader = req.headers.get('authorization');

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return new Response('Authentication r
