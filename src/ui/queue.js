/**
 * 消息队列协调器。
 *
 * 语义（对齐 SmartPageAgent 的 message_tasks 设计）：
 *   1. 用户发送 → 立即入队（status=queued），不直接执行；
 *   2. 若当前空闲 → 立刻认领队首（status=running）并执行；
 *   3. 执行期间用户继续发送 → 继续入队，界面显示「N 条排队」；
 *   4. 当前轮结束 → 自动认领下一条，串行执行，永不并发。
 *
 * 这样一个会话内的请求严格串行，避免同一会话并发写事件导致顺序错乱。
 */
import {
  enqueueTask, listSessionTasks, claimNextTask, finishTask, cancelTask, updateTask
} from '../engine/repository/task.js'

/** 剥离 Vue 响应式代理，只保留可结构化克隆的字段 */
function toPlainAttachments(list) {
  if (!Array.isArray(list)) return []
  return list.map((a) => ({
    id: String(a?.id || ''),
    file_name: String(a?.file_name || ''),
    content_type: String(a?.content_type || ''),
    size: Number(a?.size || 0),
    data_url: String(a?.data_url || ''),
  })).filter((a) => a.data_url)
}

export class SessionQueue {
  /**
   * @param {object} opts
   * @param {number} opts.sessionId
   * @param {(task:object) => Promise<void>} opts.runner  真正执行一条任务
   * @param {() => void} [opts.onChange]                  队列变化回调
   */
  constructor({ sessionId, runner, onChange, onIdle }) {
    this.sessionId = sessionId
    this.runner = runner
    this.onChange = onChange || (() => {})
    this.onIdle = onIdle || null
    this.draining = false
    this.paused = false
    this._mustStop = false
  }

  /** 读取当前排队中的任务（含 running） */
  async list() {
    return listSessionTasks(this.sessionId)
  }

  /** 新增一条任务并尝试开始执行 */
  async push({ content, attachmentIds = [], attachments = [] }) {
    const task = await enqueueTask(this.sessionId, {
      content,
      attachment_ids: attachmentIds,
      // Vue 的响应式对象是 Proxy，structuredClone 无法克隆 → IndexedDB 写入报
      // "could not be cloned"。这里先转成纯对象再落库。
      attachments: toPlainAttachments(attachments),
    })
    /* 立即视为忙碌：drain 是异步的，任务要等一拍才变 running。
     * 若只靠 onChange 回调刷新，用户在这个窗口内点切换会话会被放行，
     * 结果「对话进行到一半切走，回来整轮消失」。 */
    this.busyHint = true
    this.onChange()
    this.drain().finally(() => {
      this.busyHint = false
      this.onChange()
    })
    return task
  }

  /** 取消一条排队任务 */
  async cancel(taskId) {
    const ok = await cancelTask(this.sessionId, taskId)
    this.onChange()
    return ok
  }

  /** 编辑排队任务的正文 */
  async edit(taskId, { content, attachmentIds, attachments }) {
    const patch = {}
    if (content !== undefined) patch.content = content
    if (attachmentIds !== undefined) patch.attachment_ids = attachmentIds
    if (attachments !== undefined) patch.attachments = toPlainAttachments(attachments)
    const next = await updateTask(taskId, patch)
    this.onChange()
    return next
  }

  /** 停止当前执行（不取消排队） */
  stop() {
    this._mustStop = true
    if (this.abortController) {
      try { this.abortController.abort() } catch (_) {}
    }
  }

  /**
   * 串行消费队列。
   * 用 draining 标志保证同一时刻只有一个消费循环，避免多次 push 触发并发执行。
   */
  async drain() {
    if (this.draining || this.paused) return
    this.draining = true
    try {
      while (true) {
        const task = await claimNextTask(this.sessionId)
        if (!task) break
        this.onChange()

        this._mustStop = false
        this.abortController = new AbortController()
        try {
          await this.runner(task, this.abortController.signal)
        } catch (err) {
          // 单条任务失败不应中断队列：记下来继续处理下一条
          this.lastError = err
        } finally {
          await finishTask(task.id).catch(() => {})
          this.abortController = null
          this.onChange()
        }
      }
    } finally {
      this.draining = false
      this.abortController = null
      this.onChange()
      /* 队列彻底空转 = 这一会话真的没有在跑的任务了。
       * 这是唯一可靠的「空闲」时机：在 executeTask 的 finally 里查库，
       * 那条任务还是 running（DB 写入 done 尚未提交），会误判为仍在忙。 */
      this.onIdle?.()
    }
  }
}
