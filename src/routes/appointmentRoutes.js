import express from 'express'
import { google } from 'googleapis'
import prisma from '../prismaClient.js'
import authMiddleware from '../middleware/authMiddleware.js'

const router = express.Router()

// ----- Google OAuth2 client -----
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.SECRET_ID,
  process.env.REDIRECT
)

let tokensSet = false
const CAREGIVER_CALENDAR_ID = 'primary' // single caregiver

// ---------- Google login to connect caregiver calendar ----------
router.get('/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar']
  })
  res.redirect(url)
})

router.get('/redirect', async (req, res) => {
  const code = req.query.code

  if (!code) {
    return res.status(400).send('No ?code provided from Google')
  }

  try {
    const { tokens } = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)
    tokensSet = true
    console.log('Google Calendar OAuth tokens set.')
    res.redirect('/')
  } catch (err) {
    console.error('Error exchanging code for token:', err)
    res.status(500).send('Failed to authorize Google Calendar.')
  }
})

// ---------- PROTECTED ROUTES (patients must be logged in) ----------

// GET /appointments/available
router.get('/available', authMiddleware, async (req, res) => {
  if (!tokensSet) {
    return res.status(400).send('Google calendar is not authorized yet.')
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    const now = new Date()
    const oneMonthFromNow = new Date()
    oneMonthFromNow.setMonth(oneMonthFromNow.getMonth() + 1)

    const response = await calendar.events.list({
      calendarId: CAREGIVER_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: oneMonthFromNow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    })

    const events = response.data.items || []

    // ONLY events whose summary contains "AVAILABLE"
    const available = events.filter(
      (ev) => (ev.summary || '').toUpperCase().includes('AVAILABLE')
    )

    res.json(available)
  } catch (err) {
    console.error('Error fetching available slots:', err)
    res.status(500).send('Failed to fetch available slots.')
  }
})

// POST /appointments/book/:eventId
router.post('/book/:eventId', authMiddleware, async (req, res) => {
  if (!tokensSet) {
    return res.status(400).send('Google calendar is not authorized yet.')
  }

  const userId = req.userId
  const eventId = req.params.eventId

  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    // 1) Load the event from Google
    const { data: event } = await calendar.events.get({
      calendarId: CAREGIVER_CALENDAR_ID,
      eventId
    })

    if (!event) {
      return res.status(404).send('Event not found in calendar.')
    }

    const summary = (event.summary || '').toUpperCase()
    if (!summary.includes('AVAILABLE')) {
      return res.status(400).send('This slot is not available anymore.')
    }

    // 2) Update the event to show it's booked
    const updatedEvent = {
      ...event,
      summary: 'BOOKED' // or `BOOKED - patient #${userId}` if you want
    }

    await calendar.events.update({
      calendarId: CAREGIVER_CALENDAR_ID,
      eventId,
      resource: updatedEvent
    })

    // 3) Create DB row as BOOKED
    const startIso = event.start.dateTime || event.start.date
    const endIso = event.end.dateTime || event.end.date

    const appointment = await prisma.appointment.create({
      data: {
        startTime: new Date(startIso),
        endTime: new Date(endIso),
        status: 'BOOKED',
        googleEventId: eventId,
        patientId: userId
      }
    })

    res.json(appointment)
  } catch (err) {
    console.error('Error booking appointment:', err)
    res.status(500).send('Failed to book appointment.')
  }
})

// POST /appointments/cancel/:eventId
router.post('/cancel/:eventId', authMiddleware, async (req, res) => {
  if (!tokensSet) {
    return res.status(400).send('Google calendar is not authorized yet.')
  }

  const userId = req.userId
  const eventId = req.params.eventId

  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    // 1) Load the event
    const { data: event } = await calendar.events.get({
      calendarId: CAREGIVER_CALENDAR_ID,
      eventId
    })

    if (!event) {
      return res.status(404).send('Event not found in calendar.')
    }

    // 2) Change the event back to AVAILABLE
    const updatedEvent = {
      ...event,
      summary: 'AVAILABLE'
    }

    await calendar.events.update({
      calendarId: CAREGIVER_CALENDAR_ID,
      eventId,
      resource: updatedEvent
    })

    // 3) Mark user's appointment row as CANCELLED
    await prisma.appointment.updateMany({
      where: {
        googleEventId: eventId,
        patientId: userId,
        status: 'BOOKED'
      },
      data: {
        status: 'CANCELLED'
      }
    })

    res.json({ message: 'Appointment cancelled.' })
  } catch (err) {
    console.error('Error cancelling appointment:', err)
    res.status(500).send('Failed to cancel appointment.')
  }
})

// GET /appointments/mine
router.get('/mine', authMiddleware, async (req, res) => {
  const userId = req.userId

  try {
    const appointments = await prisma.appointment.findMany({
      where: {
        patientId: userId,
        status: 'BOOKED'   // 👈 ONLY show booked, not cancelled or available
      },
      orderBy: {
        startTime: 'asc'
      }
    })

    res.json(appointments)
  } catch (err) {
    console.error('Error fetching user appointments:', err)
    res.status(500).json({ message: 'Failed to load appointments' })
  }
})

export default router