/**
 * 事件 VO：把 message_events 表的原始行转换成前端消费的结构。
 *
 * 关键设计：实时推送与历史加载必须用同一套结构，
 * 否则「流式渲染」和「事件完成渲染」会出现两套外观。
 * 后端 runtime 通过 emitEvent 推送同一形状的快照，
 * 前端按 id upsert 进同一个事件数组，由同一个渲染器统一渲染。
 */

/** 单条事件的 VO 形状（与 session_business.listSessionEvents 保持一致） */
export function toEventVo(event) {
  if (!event) return null
  return {
    id: event.id,
    session_id: event.session_id,
    turn_id: event.turn_id,
    parent_event_id: event.parent_event_id ?? null,
    event_type: event.event_type,
    status: event.status,
    summary: event.summary ?? '',
    revision: event.revision ?? 1,
    created_at: event.created_at,
    updated_at: event.updated_at ?? event.created_at,
    content: event.context?.content ?? '',
    attachments: event.context?.attachments ?? [],
    reasoning: event.context?.reasoning ?? '',
    tool_calls: event.context?.tool_calls ?? [],
    tool_call_id: event.context?.tool_call_id ?? '',
    name: event.context?.name ?? '',
    arguments: event.context?.arguments ?? null,
    result: event.context?.result ?? null,
    ok: event.context?.ok,
    round: event.context?.round ?? null,
    attempt: event.context?.attempt ?? null,
    retry_count: event.context?.retry_count ?? null,
    max_retries: event.context?.max_retries ?? null,
    delay_ms: event.context?.delay_ms ?? null,
    backoff_capped: event.context?.backoff_capped ?? false,
    attempts: event.context?.attempts ?? [],
    agent_id: event.context?.agent_id ?? null,
    agent_name: event.context?.agent_name ?? null,
    title: event.context?.title ?? '',
    task: event.context?.task ?? '',
    access_mode: event.context?.access_mode ?? '',
    usage: event.context?.usage ?? null,
    context: event.context ?? {}
  }
}
