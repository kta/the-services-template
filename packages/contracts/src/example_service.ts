import { z } from 'zod'

/**
 * Example domain: a generic "item" (title + body). This whole service is a
 * copy-me starting point — rename `example_service` → your service and `item`
 * → your entity. Zod is the single source of truth: the backend validates with
 * these schemas and the frontend derives its types via z.infer.
 */
export const CreateItem = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).default(''),
})
export type CreateItem = z.infer<typeof CreateItem>

export const Item = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  title: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
})
export type Item = z.infer<typeof Item>
