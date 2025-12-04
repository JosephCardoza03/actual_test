import jwt from 'jsonwebtoken'
import prisma from '../prismaClient.js'

async function authMiddleware(req, res, next) {

  // Expect "Authorization: Bearer TOKEN"
  const authHeader = req.headers['authorization']

  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" })
  }

  // Remove "Bearer " from token string
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.substring(7)
    : authHeader

  try {
    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    // Fetch full user from DB
    const user = await prisma.user.findUnique({
      where: { id: decoded.id }
    })

    if (!user) {
      return res.status(401).json({ message: "User not found" })
    }

    // Attach user to request (IMPORTANT)
    req.user = user
    next()

  } catch (err) {
    console.error('JWT error:', err.message)
    return res.status(401).json({ message: "Invalid token" })
  }
}

export default authMiddleware