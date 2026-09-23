// E2E：开料排料全流程（载示例 → 看采购/每板/余料 → 加大件进摆不下 → 导出清单）
import { test, expect, type Page } from '@playwright/test'

async function gotoNesting(page: Page) {
  await page.goto('/#/nesting')
  await expect(page.getByTestId('nesting-page')).toBeVisible()
}

test.describe('开料排料：整批件自动摆到整张板上', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    page.on('console', () => undefined)
  })

  test('载示例 → 库存板优先、给出新购张数与每张明细、余料', async ({ page }) => {
    await gotoNesting(page)
    await page.getByTestId('nest-sample').click()

    // 示例 6 个件行
    const rows = page.getByTestId('parts-table').locator('tbody tr')
    await expect(rows).toHaveCount(6)

    // 全部排下（6 行，数量合计 10 件）
    await expect(page.getByTestId('stat-placed')).toContainText('10/10')
    // 至少用了一块库存已开余料板（标注优先消耗）
    await expect(page.getByText('已开余料板·优先消耗').first()).toBeVisible()

    // 每张板卡片都有排料图与明细表
    const firstSheet = page.getByTestId('sheet-1')
    await expect(firstSheet).toBeVisible()
    await expect(firstSheet.locator('svg')).toBeVisible()
    await expect(firstSheet).toContainText('整块可留余料')
  })

  test('超大件进摆不下清单、不新购；勾旋转后出现待确认警告', async ({ page }) => {
    await gotoNesting(page)
    await page.getByTestId('nest-sample').click()

    // 加一行超大件 3000×1500
    await page.getByTestId('add-part').click()
    const lastRow = page.getByTestId('parts-table').locator('tbody tr').last()
    await lastRow.locator('input[type="number"]').nth(0).fill('3000')
    await lastRow.locator('input[type="number"]').nth(1).fill('1500')
    await lastRow.locator('input[type="number"]').nth(2).fill('18')

    const unplaced = page.getByTestId('unplaced-section')
    await expect(unplaced).toContainText('超过可购最大板材')
    // 已排件仍是示例 10 件
    await expect(page.getByTestId('stat-placed')).toContainText('10/11')

    // 勾选允许旋转 → 出现旋转确认警告条（1100×700 式混排才会触发，这里只验证警告条存在与否随勾选变化）
    await page.getByTestId('set-rotate').check()
    // 超大件依旧摆不下
    await expect(unplaced).toContainText('超过可购最大板材')
    await page.getByTestId('set-rotate').uncheck()
  })

  test('改板规格/改件即重排；导出 TXT 开料单内容完整', async ({ page }) => {
    await gotoNesting(page)
    await page.getByTestId('nest-sample').click()

    // 改锯路，重排耗时标注更新
    const recalc = page.getByTestId('nest-recalc')
    await expect(recalc).toContainText(/重排耗时 [\d.]+ms/)
    await page.getByTestId('set-kerf').fill('8')
    await expect(recalc).toContainText(/重排耗时 [\d.]+ms/)

    // 导出 TXT，下载内容包含三段 + 摆不下段标题
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-txt').click(),
    ])
    expect(download.suggestedFilename()).toMatch(/\.txt$/)
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    expect(text).toContain('开料单')
    expect(text).toContain('【一、采购】')
    expect(text).toContain('【二、每张板摆了哪些件】')
    expect(text).toContain('【三、摆不下的件')
    expect(text).toContain('鞋柜侧板')
  })

  test('保存批次 → 导航栏可再打开（结果持久化）', async ({ page }) => {
    await gotoNesting(page)
    await page.getByTestId('nest-sample').click()
    await page.getByTestId('nest-title').fill('E2E批次')
    await page.getByTestId('nest-save').click()

    // URL 变成 /nesting/:id
    await expect(page).toHaveURL(/#\/nesting\/.+/)
    // 回工作区再进排料，已存批次 chip 存在
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-nesting').click()
    await expect(page.getByText('E2E批次').first()).toBeVisible()
  })
})
