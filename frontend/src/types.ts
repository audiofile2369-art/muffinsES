export type SaleStatus = 'planning' | 'ready' | 'live' | 'closed' | 'archived'

export type ItemStatus =
  | 'available'
  | 'sold'
  | 'discounted'
  | 'reserved'
  | 'donated'
  | 'removed'

export type TaskStatus = 'todo' | 'in_progress' | 'done'

export interface SaleRead {
  id: number
  title: string
  address: string
  start_date: string
  end_date: string
  status: SaleStatus
  notes: string
}

export interface SaleSummary extends SaleRead {
  item_count: number
  priced_count: number
  sold_count: number
  pending_task_count: number
  estimated_revenue: number
  realized_revenue: number
}

export interface DashboardResponse {
  sales: SaleSummary[]
}

export interface CategoryRead {
  id: number
  name: string
  color: string
  sort_order: number
}

export interface ItemRead {
  id: number
  sale_id: number
  category_id: number | null
  title: string
  description: string
  room: string
  condition: string
  price: number | null
  status: ItemStatus
  notes: string
  photo_url: string | null
}

export interface TaskRead {
  id: number
  sale_id: number
  title: string
  due_date: string | null
  status: TaskStatus
  notes: string
}

export interface CategoryBreakdown {
  category_name: string
  item_count: number
  sold_count: number
  listed_value: number
  sold_value: number
}

export interface RoomBreakdown {
  room_name: string
  item_count: number
  listed_value: number
}

export interface ReportMetrics {
  total_items: number
  priced_items: number
  sold_items: number
  total_listed_value: number
  total_sold_value: number
  sell_through_rate: number
  category_breakdown: CategoryBreakdown[]
  room_breakdown: RoomBreakdown[]
}

export interface WorkspaceResponse {
  sale: SaleRead
  summary: SaleSummary
  categories: CategoryRead[]
  items: ItemRead[]
  tasks: TaskRead[]
  report: ReportMetrics
}

export interface SalePayload {
  title: string
  address: string
  start_date: string
  end_date: string
  status: SaleStatus
  notes: string
}

export interface CategoryPayload {
  name: string
  color: string
  sort_order: number
}

export interface ItemPayload {
  sale_id: number
  category_id: number | null
  title: string
  description: string
  room: string
  condition: string
  price: number | null
  status: ItemStatus
  notes: string
  photo_url: string | null
}

export type ItemUpdatePayload = Omit<ItemPayload, 'sale_id'>

export interface TaskPayload {
  sale_id: number
  title: string
  due_date: string | null
  status: TaskStatus
  notes: string
}

export type TaskUpdatePayload = Omit<TaskPayload, 'sale_id'>

export interface BulkItemUpdatePayload {
  item_ids: number[]
  status?: ItemStatus
  category_id?: number | null
}

export interface PricingEstimateResponse {
  suggested_title: string
  suggested_category: string
  suggested_room: string
  estimated_price: number | null
  low_estimate: number | null
  high_estimate: number | null
  reasoning: string
  follow_up_questions: string[]
}
