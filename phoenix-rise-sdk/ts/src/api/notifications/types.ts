import z from "zod";

export interface GetNotificationsQuery {
  limit?: number;
  cursor?: string;
  unackedOnly?: boolean;
}

export const GetNotificationsQuerySchema: z.ZodType<GetNotificationsQuery> =
  z.object({
    limit: z.number().int().positive().max(100).optional(),
    cursor: z.string().optional(),
    unackedOnly: z.boolean().optional(),
  });

export interface EventNotificationItem {
  source: "event";
  id: number;
  slot: number;
  slotIndex: number;
  instructionIndex: number;
  eventIndex: number;
  recipientIndex: number;
  createdAt: string;
  acked: boolean;
  notificationType: string;
  data: unknown;
}

export interface AdminNotificationItem {
  source: "admin";
  id: number;
  notificationType: string;
  title?: string | null;
  body: string | null;
  data: unknown;
  createdAt: string;
  acked: boolean;
}

export interface GeneralNotificationItem {
  source: "general";
  id: number;
  notificationType: string;
  title?: string | null;
  body: string | null;
  data: unknown;
  createdAt: string;
  acked: boolean;
}

export type NotificationItem =
  | EventNotificationItem
  | AdminNotificationItem
  | GeneralNotificationItem;

const EventNotificationItemSchema = z.object({
  source: z.literal("event"),
  id: z.number(),
  slot: z.number(),
  slotIndex: z.number(),
  instructionIndex: z.number(),
  eventIndex: z.number(),
  recipientIndex: z.number(),
  createdAt: z.string(),
  acked: z.boolean(),
  notificationType: z.string(),
  data: z.unknown(),
});

const AdminNotificationItemSchema = z.object({
  source: z.literal("admin"),
  id: z.number(),
  notificationType: z.string(),
  title: z.string().nullable().optional(),
  body: z.string().nullable(),
  data: z.unknown(),
  createdAt: z.string(),
  acked: z.boolean(),
});

const GeneralNotificationItemSchema = z.object({
  source: z.literal("general"),
  id: z.number(),
  notificationType: z.string(),
  title: z.string().nullable().optional(),
  body: z.string().nullable(),
  data: z.unknown(),
  createdAt: z.string(),
  acked: z.boolean(),
});

export const NotificationItemSchema: z.ZodType<NotificationItem> =
  z.discriminatedUnion("source", [
    EventNotificationItemSchema,
    AdminNotificationItemSchema,
    GeneralNotificationItemSchema,
  ]) as z.ZodType<NotificationItem>;

export interface GetNotificationsResponse {
  items: NotificationItem[];
  nextCursor: string | null;
}

export const GetNotificationsResponseSchema: z.ZodType<GetNotificationsResponse> =
  z.object({
    items: z.array(NotificationItemSchema),
    nextCursor: z.string().nullable(),
  });

export interface AckBeforeTimestampBody {
  beforeTimestamp: string;
}

export const AckBeforeTimestampBodySchema: z.ZodType<AckBeforeTimestampBody> =
  z.object({
    beforeTimestamp: z.string(),
  });

export type AckNotificationItem =
  | {
      type: "event";
      id?: number;
      slot?: number;
      slotIndex?: number;
      instructionIndex?: number;
      eventIndex?: number;
      recipientIndex?: number;
    }
  | { type: "admin"; id: number }
  | { type: "general"; id: number };

export const AckNotificationItemSchema: z.ZodType<AckNotificationItem> =
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("event"),
      id: z.number().optional(),
      slot: z.number().optional(),
      slotIndex: z.number().optional(),
      instructionIndex: z.number().optional(),
      eventIndex: z.number().optional(),
      recipientIndex: z.number().optional(),
    }),
    z.object({
      type: z.literal("admin"),
      id: z.number(),
    }),
    z.object({
      type: z.literal("general"),
      id: z.number(),
    }),
  ]);

export interface AckNotificationsBody {
  items: AckNotificationItem[];
}

export const AckNotificationsBodySchema: z.ZodType<AckNotificationsBody> =
  z.object({
    items: z.array(AckNotificationItemSchema),
  });
