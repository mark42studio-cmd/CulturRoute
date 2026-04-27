import { NextRequest, NextResponse } from 'next/server'

export const config = {
  matcher: ['/admin', '/admin/:path*'],
}

export function proxy(req: NextRequest) {
  const authHeader = req.headers.get('authorization')

  if (authHeader?.startsWith('Basic ')) {
    const base64 = authHeader.slice('Basic '.length)
    // Proxy runs on Node.js runtime — use Buffer instead of atob()
    const decoded = Buffer.from(base64, 'base64').toString('utf8')
    const colonIdx = decoded.indexOf(':')
    const username = decoded.slice(0, colonIdx)
    const password = decoded.slice(colonIdx + 1)

    if (
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    ) {
      return NextResponse.next()
    }
  }

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="CultureRoute Admin"',
    },
  })
}
