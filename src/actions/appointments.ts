'use server'

import prisma from '@/lib/prisma'
import { currentUser } from '@clerk/nextjs/server'
import { appointment, AppointmentStatus, Prisma } from '@prisma/client'
import { isBefore } from 'date-fns'
import { revalidatePath } from 'next/cache'
import { subYears, format } from 'date-fns'
import { clerkClient } from '@/lib/clerk-client'
import { sendMail } from './email'
import { render } from '@react-email/render'
import { AppointmentFeedback } from '@/components/emails/appointment-feedback'

interface NewAppointmentData
  extends Omit<appointment, 'status' | 'id' | 'updatedAt' | 'createdAt'> {}

export interface GroupedAppointments {
  [date: string]: Prisma.appointmentGetPayload<{
    include: { appointment_type: { select: { name: true; duration: true } } }
  }>[]
}

interface GetAppointmentsParams {
  userId: string
  status: AppointmentStatus
}

export const get = async ({
  userId,
  status
}: Partial<GetAppointmentsParams> = {}) => {
  const appointments = await prisma.appointment.findMany({
    orderBy: { start_at: 'desc' },
    where: { patient_clerk_id: userId, status },
    include: { appointment_type: { select: { name: true, duration: true } } }
  })

  const groupedAppointments = appointments.reduce((acc, appointment) => {
    const date = appointment.start_at.toISOString().split('T')[0]
    if (!acc[date]) acc[date] = []

    acc[date].push(appointment)

    return acc
  }, {} as GroupedAppointments)

  return groupedAppointments
}

const create = async (data: NewAppointmentData) => {
  const appointment = await prisma.appointment.create({ data })

  await prisma.notifications.create({
    data: {
      title: 'New appointment',
      content: `You have a new appointment on ${format(data.start_at, 'MMMM d, yyyy')} at ${format(data.start_at, 'h:mm a')}`,
      url: `/admin/appointments?selected=${appointment.id}`
    }
  })

  return appointment
}

const edit = async (
  appointment: string,
  data: Partial<Omit<NewAppointmentData, 'patient_clerk_id'>>
) => {
  const appointmentData = await prisma.appointment.findUniqueOrThrow({
    where: { id: appointment },
    select: { patient_clerk_id: true, start_at: true, status: true }
  })

  if (appointmentData.status !== AppointmentStatus.SCHEDULED) {
    throw new Error('This ppointment is not longer editable')
  }

  const user = await currentUser()

  const doctorClerkId = process.env.DOCTOR_CLERK_ID

  if (
    user?.id !== appointmentData.patient_clerk_id &&
    user?.id !== doctorClerkId
  ) {
    throw new Error('Unauthorized')
  }

  const appointmentType = await prisma.appointment_type.findUniqueOrThrow({
    where: { id: data.appointment_type_id },
    select: { duration: true }
  })

  /**
   * Date de fin du rendez-vous en millisecondes
   */
  const appointmentEndDate =
    new Date(appointmentData.start_at).getTime() +
    appointmentType.duration * 60 * 1000

  const now = Date.now()

  if (appointmentEndDate < now) {
    throw new Error('This appointment is already ended')
  }

  const updatedAppointment = prisma.appointment.update({
    where: { id: appointment },
    data
  })

  return updatedAppointment
}

const manage = async (
  action: 'accept' | 'cancel' | 'finish',
  appointment: string
) => {
  const user = await currentUser()

  const doctorClerkId = process.env.DOCTOR_CLERK_ID

  if (user?.id !== doctorClerkId) {
    throw new Error("You're not authorized to manage this appointment")
  }

  const appointmentData = await prisma.appointment.findUniqueOrThrow({
    where: { id: appointment },
    select: { patient_clerk_id: true, status: true, start_at: true }
  })

  if (appointmentData.status !== AppointmentStatus.PENDING) {
    throw new Error('This appointment is no longer editable !')
  }

  if (isBefore(appointmentData.start_at, new Date())) {
    await prisma.appointment.update({
      where: { id: appointment },
      data: { status: AppointmentStatus.CANCELLED }
    })

    revalidatePath('/admin/appointments')

    throw new Error('This appointment is no longer editable !')
  }

  const updatedAppointment = await prisma.appointment.update({
    where: { id: appointment },
    data: {
      status:
        action === 'accept'
          ? AppointmentStatus.SCHEDULED
          : action === 'cancel'
            ? AppointmentStatus.CANCELLED
            : AppointmentStatus.COMPLETED
    },
    include: { appointment_type: { select: { name: true, duration: true } } }
  })

  if (action !== 'finish') {
    const { emailAddresses, fullName } = await clerkClient.users.getUser(
      appointmentData.patient_clerk_id
    )

    const html = await render(
      AppointmentFeedback({ fullName, appointment: updatedAppointment, action })
    )

    sendMail({
      to: emailAddresses[0].emailAddress,
      subject: `Doctrin appointment`,
      html
    })
  }

  revalidatePath('/admin/appointments')

  return updatedAppointment
}

const getAppointmentsPerMonth = async () => {
  const oneYearAgo = subYears(new Date(), 1)

  const appointments = await prisma.appointment.findMany({
    where: { start_at: { gte: oneYearAgo } },
    select: { start_at: true }
  })

  const monthCounts: { [key: string]: number } = {}

  appointments.forEach(appointment => {
    const monthYear = format(appointment.start_at, 'MMMM yyyy')
    monthCounts[monthYear] = (monthCounts[monthYear] || 0) + 1
  })

  const chartData = Object.entries(monthCounts).map(([month, count]) => ({
    month,
    count
  }))

  return chartData
}

export const getAppointmentsByStatus = async () => {
  const statusCounts = await prisma.appointment.groupBy({
    by: ['status'],
    _count: { status: true }
  })

  return statusCounts.map(item => ({
    status: item.status,
    count: item._count.status,
    fill: `var(--color-${item.status})`
  }))
}

export { create, edit, manage, getAppointmentsPerMonth }
