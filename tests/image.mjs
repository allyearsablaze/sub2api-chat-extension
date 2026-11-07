import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import { buildImageOptions } from '../src/engine/runtime/tools/image_options.js'
import { parseImageResults, imageExtension } from '../src/engine/common/image.js'
import { isImageModel, registerImageTool } from '../src/engine/runtime/tools/image.js'
import { registerImageEditTool } from '../src/engine/runtime/tools/image_edit.js'
import { toolRegistry } from '../src/engine/runtime/tools/registry.js'

registerImageTool()
registerImageEditTool()
for (const name of ['generate_image', 'edit_image']) {
  const properties = toolRegistry.tools.get(name).parameters.properties
  assert.deepEqual(properties.output_format.enum, ['png', 'jpeg', 'webp', 'gif', 'svg'])
  assert.equal(properties.svg.properties.reasoning.properties.effort.type, 'string')
}

const ctx = { platform: 'openai', model: 'gpt-image-2.6-flare' }
for (const model of ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']) {
  assert.equal(isImageModel(model, 'openai'), true)
  assert.equal(buildImageOptions({ output_format: 'svg' }, { ...ctx, model }).output_format, 'svg')
}
for (const args of [
  { output_format: 'bmp' },
  { output_format: 'png', frame_count: 2 },
  { output_format: 'gif', frame_count: 1.5 },
  { output_format: 'gif', frame_duration_ms: 0 },
  { output_format: 'gif', frame_count: '2' },
  { output_format: 'svg', svg: [] },
  { output_format: 'svg', svg: { reasoning: 'high' } },
  { output_format: 'svg', svg: { ignored: true } },
  { output_format: 'gif', svg: {} },
]) assert.throws(() => buildImageOptions(args, ctx), { code: 'IMAGE_INVALID_OPTIONS' })
for (const unsupported of [
  { platform: 'openai', model: 'gpt-image-1' },
  { platform: 'grok', model: 'grok-imagine-image' },
  { platform: 'gemini', model: 'gemini-2.5-flash-image' },
]) assert.throws(() => buildImageOptions({ output_format: 'svg' }, unsupported), { code: 'IMAGE_INVALID_OPTIONS' })
assert.deepEqual(buildImageOptions({}, { platform: 'openai', model: 'gpt-image-1' }), {})
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
assert.equal(parseImageResults({ data: [{ b64_json: pngBytes.toString('base64') }] })[0].mime, 'image/png')
assert.equal(parseImageResults({ output_format: 'svg', data: [{ b64_json: pngBytes.toString('base64') }] }, 'svg')[0].mime, 'image/png')
assert.match(parseImageResults({ output_format: 'svg', data: [{ b64_json: pngBytes.toString('base64') }] }, 'svg')[0].format_warning, /实际返回 PNG/)
assert.equal(parseImageResults({ data: [{ url: `data:image/svg+xml;base64,${pngBytes.toString('base64')}` }] })[0].mime, 'image/png')
assert.throws(() => parseImageResults({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }), /图片内容/)
assert.equal(parseImageResults({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] })[0].mime, 'image/svg+xml')
assert.equal(imageExtension('image/svg+xml'), 'svg')
assert.equal(imageExtension('image/gif'), 'gif')
console.log('PASS model recognition, parameter validation, MIME precedence and legacy PNG')

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/><script>window.svgExecuted=true</script></svg>')
// Two valid one-pixel GIF frames, with infinite loop and a delay for each frame.
const singleGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const frame = Buffer.from(singleGif.subarray(19, -1))
frame[3] = 0
frame[4] = 10
const gif = Buffer.concat([singleGif.subarray(0, 19), Buffer.from('21ff0b4e45545343415045322e300301000000', 'hex'), frame, frame, Buffer.from([0x3b])])
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const fixture = {
  name: 'image-test-fixture',
  resolveId(id) { if (id === '/image-fixture.js') return id },
  load(id) {
    if (id !== '/image-fixture.js') return
    return `
      import * as imageVue from 'vue'
      import SafeImage from '/src/ui/components/SafeImage.vue'
      import ImagePreview from '/src/ui/components/ImagePreview.vue'
      import '/src/ui/styles.css'
      import * as imageTools from '/src/engine/runtime/tools/image.js'
      import * as editTools from '/src/engine/runtime/tools/image_edit.js'
      import * as imageCache from '/src/engine/repository/image_cache.js'
      Object.assign(window, { imageVue, SafeImage, ImagePreview, imageTools, editTools, imageCache })
    `
  },
}
const server = await createServer({ configFile: false, plugins: [vue(), fixture], server: { host: '127.0.0.1', port: 8902, strictPort: true, hmr: false } })
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ acceptDownloads: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: '<div id="image-test"></div>' }))
  let response = {}
  const requests = []
  await page.route('**/v1/images/*', async route => {
    requests.push({ url: route.request().url(), type: route.request().headers()['content-type'], body: route.request().postData() })
    await route.fulfill({ json: response })
  })
  await page.goto(origin)
  await page.evaluate(() => import('/image-fixture.js'))
  const run = (operation, args) => page.evaluate(async ({ operation, args }) => {
    const context = { apiKey: 'local-test', platform: 'openai', imageConfig: { apiKey: 'local-test', platform: 'openai', model: 'gpt-image-2.6-flare' }, sessionId: 1, turnId: 'test' }
    const result = operation === 'edit' ? await window.editTools.runImageEdit(args, context) : await window.imageTools.runImageGeneration(args, context)
    return { result, row: await window.imageCache.getImage(result.images[0].id) }
  }, { operation, args })
  async function verifyCard(row, expected, format) {
    await page.evaluate(async row => {
      window.imageApp?.unmount()
      const { createApp, h } = window.imageVue
      window.imageApp = createApp({ render: () => h(window.SafeImage, { entry: { id: row.id }, onPreview: src => { window.previewSource = src } }) })
      window.imageApp.mount('#image-test')
    }, row)
    try {
      await page.waitForFunction(() => document.querySelector('#image-test img')?.naturalWidth > 0, null, { timeout: 5000 })
    } catch (error) {
      console.error(await page.locator('#image-test').innerHTML())
      throw error
    }
    if (process.env.IMAGE_SCREENSHOT_DIR) {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(process.env.IMAGE_SCREENSHOT_DIR, { recursive: true })
      await page.locator('#image-test').screenshot({ path: `${process.env.IMAGE_SCREENSHOT_DIR}/image-card-${format}.png` })
    }
    await page.locator('#image-test img').click()
    assert.equal(await page.evaluate(() => window.previewSource), row.data_url)
    assert.equal(await page.evaluate(() => window.svgExecuted), undefined)
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载原图', exact: true }).click()
    const download = await pending
    assert.equal(download.suggestedFilename(), `${row.id}.${format}`)
    const chunks = []
    for await (const chunk of await download.createReadStream()) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), expected)
  }
  for (const [format, bytes, mime] of [['svg', svg, 'image/svg+xml'], ['gif', gif, 'image/gif']]) {
    response = { output_format: format, data: [{ b64_json: bytes.toString('base64') }] }
    const args = { prompt: `generate ${format}`, output_format: format, ...(format === 'gif' ? { frame_count: 2, frame_duration_ms: 100 } : { svg: { model: 'gpt-6-astra', reasoning: { effort: 'high' } } }) }
    const generated = await run('generate', args)
    const body = JSON.parse(requests.at(-1).body)
    assert.equal(body.output_format, format)
    assert.equal(body.model, 'gpt-image-2.6-flare')
    if (format === 'gif') assert.deepEqual([body.frame_count, body.frame_duration_ms], [2, 100])
    else assert.deepEqual(body.svg, args.svg)
    assert.equal(generated.row.mime, mime)
    assert.equal(generated.result.images[0].mime, mime)
    await verifyCard(generated.row, bytes, format)
    if (format === 'gif') {
      const frameCount = await page.evaluate(async dataUrl => {
        const data = await (await fetch(dataUrl)).arrayBuffer()
        const decoder = new ImageDecoder({ data, type: 'image/gif' })
        await decoder.tracks.ready
        const count = decoder.tracks.selectedTrack.frameCount
        const second = await decoder.decode({ frameIndex: 1 })
        second.image.close()
        decoder.close()
        return count
      }, generated.row.data_url)
      assert.equal(frameCount, 2)
    }
    const edited = await run('edit', { ...args, image: png, quality: 'high', complexity: 'low' })
    const request = requests.at(-1)
    const form = await new Request('http://local.test', { method: 'POST', headers: { 'Content-Type': request.type }, body: request.body }).formData()
    assert.equal(form.get('output_format'), format)
    assert.equal(form.get('complexity'), 'low')
    assert.equal(form.get('quality'), 'high')
    assert.equal(form.get('image').name, 'source.png')
    if (format === 'gif') assert.deepEqual([form.get('frame_count'), form.get('frame_duration_ms')], ['2', '100'])
    else assert.deepEqual(JSON.parse(form.get('svg')), args.svg)
    assert.equal(edited.row.mime, mime)
    const read = await page.evaluate(id => window.editTools.runImageRead({ image: id }), edited.row.id)
    assert.equal(read.data_url, edited.row.data_url)
    assert.equal(read.mime, mime)
    const repeated = await run('edit', { ...args, image: generated.row.id })
    const repeatRequest = requests.at(-1)
    const repeatForm = await new Request('http://local.test', { method: 'POST', headers: { 'Content-Type': repeatRequest.type }, body: repeatRequest.body }).formData()
    assert.equal(repeatForm.get('image').name, `source.${format}`)
    assert.equal(repeatForm.get('image').type, mime)
    assert.equal(repeated.row.parent_id, generated.row.id)
    await page.reload()
    const stored = await page.evaluate(async id => (await import('/src/engine/repository/image_cache.js')).getImage(id), generated.row.id)
    assert.equal(stored.data_url, generated.row.data_url)
    await page.evaluate(() => import('/image-fixture.js'))
    console.log(`PASS ${format}: generation, edit multipart, IndexedDB reload, preview and byte-exact download`)
  }
  const reproduction = process.env.IMAGE_REPRO_FILE ? await readFile(process.env.IMAGE_REPRO_FILE) : pngBytes
  for (const operation of ['generate', 'edit']) {
    response = { output_format: 'svg', data: [{ b64_json: reproduction.toString('base64') }] }
    const generated = await run(operation, { prompt: 'SVG', output_format: 'svg', image: png })
    assert.equal(generated.row.mime, 'image/png')
    assert.match(generated.result.warnings[0], /实际返回 PNG/)
    await verifyCard(generated.row, reproduction, 'png')
  }
  const legacy = await page.evaluate(async data => {
    const { db } = await import('/src/engine/repository/db.js')
    const row = { id: 'img_legacy', data_url: `data:image/svg+xml;base64,${data}`, mime: 'image/svg+xml' }
    await db.put('image_cache', row)
    return window.imageCache.getImage(row.id)
  }, reproduction.toString('base64'))
  assert.equal(legacy.mime, 'image/png')
  await verifyCard(legacy, reproduction, 'png')
  console.log('PASS mislabeled PNG: generation/edit warnings, original bytes and legacy cache preview/download')

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const mountPreview = () => page.evaluate(src => {
      window.previewApp?.unmount()
      const mount = document.querySelector('#preview-test') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'preview-test' }))
      const { createApp, h, ref } = window.imageVue
      window.previewApp = createApp({ setup() {
        const open = ref(true)
        return () => open.value ? h(window.ImagePreview, { src, onClose: () => { open.value = false } }) : null
      } })
      window.previewApp.mount(mount)
    }, legacy.data_url)
    await mountPreview()
    await page.waitForFunction(() => document.querySelector('.image-stage img')?.naturalWidth > 0)
    const image = await page.locator('.image-stage img').boundingBox()
    assert.ok(image.width <= Math.min(900, viewport.width - 24))
    assert.ok(image.height <= viewport.height * .7 + 1)
    if (process.env.IMAGE_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.IMAGE_SCREENSHOT_DIR}/preview-${viewport.width}.png` })
    }
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await mountPreview()
    await page.getByRole('button', { name: '关闭预览' }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await mountPreview()
    await page.locator('.image-overlay').click({ position: { x: 2, y: 2 } })
    await page.getByRole('dialog').waitFor({ state: 'detached' })
  }
  console.log('PASS desktop/mobile preview bounds, Esc, close button and backdrop close')
  await page.route('**/upstream-image', route => route.fulfill({ contentType: 'image/svg+xml', body: reproduction }))
  response = { data: [{ url: `${origin}/upstream-image` }] }
  const remoteImage = await run('generate', { prompt: 'svg', output_format: 'svg' })
  assert.equal(remoteImage.row.mime, 'image/png')
  assert.match(remoteImage.result.warnings[0], /实际返回 PNG/)
  await verifyCard(remoteImage.row, reproduction, 'png')
  console.log('PASS remote image actual-byte validation')
  response = { data: [{ url: `data:image/gif;base64,${gif.toString('base64')}` }] }
  assert.equal((await run('generate', { prompt: 'gif', output_format: 'gif' })).row.mime, 'image/gif')
  console.log('PASS data URL response MIME')
  await page.route('**/download-failure', route => route.fulfill({ status: 403, body: 'denied' }))
  await page.evaluate(() => {
    const { createApp, h } = window.imageVue
    createApp({ render: () => h(window.SafeImage, { entry: { src: '/download-failure' } }) }).mount('#image-test')
  })
  await page.getByRole('button', { name: '下载原图', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.download-error')?.textContent.includes('HTTP 403'))
  console.log('PASS download failure displays error')
  assert.deepEqual(errors, [], 'browser runtime errors')
} finally {
  await browser?.close()
  await server.close()
}
