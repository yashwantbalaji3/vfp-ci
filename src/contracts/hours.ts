import { z } from "zod";

/**
 * MAP-2 opening hours. The database decides the state (app.venue_hours_status); these
 * shapes only carry it. Only "open" may ever be shown as open.
 */
export const HOURS_STATES = ["open", "closed", "needs_confirmation", "temporarily_closed"] as const;
export type HoursState = (typeof HOURS_STATES)[number];

export const hoursStatusSchema = z.object({
  state: z.enum(HOURS_STATES),
  reason: z.enum(["unchecked", "out_of_date"]).optional(),
  closesAt: z.string().nullish(),
  opensAt: z.string().nullish(),
  open24h: z.boolean().optional(),
  /** Open, and 30 minutes or less before the verified closing time (decided by the database). */
  closesSoon: z.boolean().optional(),
  until: z.string().nullish(),
  note: z.string().nullish(),
  timezone: z.string(),
  checkedAt: z.string().nullish(),
});
export type HoursStatus = z.infer<typeof hoursStatusSchema>;

export const hoursStatusesSchema = z.record(z.string(), hoursStatusSchema);

const period = z.object({ day: z.number().int().min(0).max(6), opens: z.string(), closes: z.string(), closesNextDay: z.boolean() });
export type HoursPeriod = z.infer<typeof period>;
const exception = z.object({
  startsOn: z.string(),
  endsOn: z.string(),
  kind: z.enum(["closed", "special_hours", "temporary_closure"]),
  opens: z.string().nullable(),
  closes: z.string().nullable(),
  closesNextDay: z.boolean(),
  reason: z.string().nullable(),
});
export type HoursException = z.infer<typeof exception>;
export const weeklyHoursSchema = z.object({ weekly: z.array(period), exceptions: z.array(exception) });
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

export const venueHoursSchema = z.object({
  status: hoursStatusSchema,
  hours: weeklyHoursSchema.nullable(),
  checkedAt: z.string().nullable(),
  freshness: z.object({ checkedAt: z.string().nullable(), state: z.enum(["current", "due", "out_of_date"]) }).nullable(),
  source: z.record(z.string(), z.unknown()).nullable(),
});
export type VenueHours = z.infer<typeof venueHoursSchema>;

export const openNowLeftOutSchema = z.object({ placesNeedConfirmation: z.number(), placesClosed: z.number() });
export type OpenNowLeftOut = z.infer<typeof openNowLeftOutSchema>;
