import { NextRequest, NextResponse } from 'next/server'

export const config = {
  matcher: ['/admin', '/admin/:path*'],
}

export function middleware(req: NextRequest) {
  const authHeader = req.headers.get('authorization')

  if (authHeader?.startsWith('Basic ')) {
    const base64 = authHeader.slice('Basic '.length)
    const decoded = atob(base64)
    const colonIdx = decoded.indexOf(':')
    const username = decoded.slice(0, colonIdx)
    const password = decoded.slice(colonIdx + 1)

    const validUser = process.env.ADMIN_USERNAME
    const validPass = process.env.ADMIN_PASSWORD

    if (username === validUser && password === validPass) {
      return NextResponse.next()
    }
  }

  return new NextResponse('Auth required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Secure Area"',
    },
  })
}
