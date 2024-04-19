import puppeteer, { ElementHandle, Page, BoundingBox, Viewport, Browser } from "puppeteer"
import fs from 'fs/promises'
import cliProgress from 'cli-progress'
import path from 'path'
import { Command } from "commander";
const program = new Command();
import { mkdir, writeFile } from 'fs/promises'

program
  .version("1.0.0")
  .description("Contab Notas de Entrada")
  .option("-o, --output <output path>", "Caminho da saída")
  .parse(process.argv)

const options = program.opts()
const outputBasePath = options.output ? [options.output] : [__dirname, 'output']

const minimalPdf = `%PDF-1.
1 0 obj<</Pages 2 0 R>>endobj
2 0 obj<</Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Parent 2 0 R>>endobj
trailer <</Root 1 0 R>>`;

async function waitForDownload(page: Page)
{
    await page.waitForSelector('.black-overlay')
    await page.waitForSelector('.black-overlay', { hidden: true, timeout: 60000 })
}

async function waitForBlobUrlTarget(browser: Browser): Promise<Page> {
    return new Promise(resolve => {
      browser.on('targetcreated', async (target) => {
        const newPage = await target.page()
        if (newPage) {
          const url = newPage.url()
          if (url.startsWith('blob:')) {
            resolve(newPage)
          }
        }
      })
    })
}

function screenshot(output: string, page: any, cardBoundingBox: BoundingBox, viewport: Viewport)
{
    return page.screenshot({
        type: 'png',
        path: output,
        clip: {
            x: cardBoundingBox.x,
            y: cardBoundingBox.y,
            width: Math.min(cardBoundingBox.width, viewport.width),
            height: Math.min(cardBoundingBox.height),
        }
    })
}

export async function main()
{
    const bar = new cliProgress.SingleBar({
        format: ' {bar} | {empresa}: {status} | {value}/{total}'
    }, cliProgress.Presets.shades_classic)

    // Parse companies CSV
    const csv = await fs.readFile(__dirname + '/input.csv', { encoding: 'utf-8' })
    const rows = csv.split('\n').map(r => r.split(';'))
    const data = rows.slice(1).map(row => Object.fromEntries(row.map((value, i) => [rows[0][i], value])))

    // Launch browser
    const browser = await puppeteer.launch({ headless: false })
    const page = await browser.newPage()

    bar.start(Object.keys(data).length, 0)
    var i = 0;
    for (const row of data) {
        try {
            i = i + 1
            bar.update(i, { empresa: row.EMPRESA, status: 'Autenticando' })

            // Sign-in
            await page.goto('https://contribuinte.sefaz.al.gov.br/#/')
            await page.waitForSelector('.action-button')
            await page.click('.action-button')
            await page.waitForSelector('#username')
            await page.waitForSelector('#password')
            await page.type('#username', row.LOGIN)
            await page.type('#password', row.SENHA)
            page.click('button[type="submit"]')
            await page.waitForSelector('#mensagem-logado-como', {timeout: 60000})

            await page.goto('https://contribuinte.sefaz.al.gov.br/cobrancadfe/#/calculo-nfe')

            let date = new Date()
            date.setDate(0)

            bar.update(i, { empresa: row.EMPRESA, status: 'Pesquisando Antecipado', })

            // Get CNPJ
            const cnpjElement = (await page.waitForSelector('.alert.alert-data')) as ElementHandle
            const cnpjText = await (await cnpjElement.getProperty('textContent')).jsonValue() as string
            const cnpj = cnpjText.replace(/[^\d]/g, '')

            // Apply query
            const dataButton = await page.waitForSelector(`#pickerForm .row div.col-4:nth-child(${date.getMonth() + 4}) span`) as ElementHandle
            await dataButton.evaluate((button: any) => button.click())
            await page.click('button[type=submit]')
            await new Promise((resolve) => setTimeout(resolve, 2000))

            // Screenshot
            await page.setViewport({ width: 1600, height: 500, })
            const card = await page.$('.card') as ElementHandle
            const cardBoundingBox = await card.boundingBox() as BoundingBox
            const viewport = page.viewport() as Viewport
            const outputDir = path.join(...outputBasePath, `${row.EMPRESA} - ${cnpj}`)
            await mkdir(outputDir, { recursive: true }).catch(_ => {})
            
            const screenshotOutput = `${outputDir}/anteicipado-${date.getFullYear()}-${date.getMonth() + 1}.png`
            await screenshot(screenshotOutput, page, cardBoundingBox, viewport)

            // Print
            await page.evaluate(() => {
                // @ts-ignore
                document.querySelector('body > jhi-main > div.container-fluid > div > jhi-calculo-nfe > div > div:nth-child(7) > div:nth-child(2) > div > div > div > div:nth-child(1) > button').click()
            })
            
            const newTarget = await page.browserContext().waitForTarget(
                target => target.url().startsWith('blob:')
            )
            const newPage = await newTarget.page() as Page
            const blobUrl = newPage.url()
            const blobData = await page.evaluate(async (url) => {
                const response = await fetch(url);
                const blob = await response.blob()

                // @ts-ignore
                const reader = new FileReader()
                    reader.readAsDataURL(blob);
                    return new Promise(resolve => {
                      reader.onloadend = () => {
                        resolve(reader.result)
                    }
                })
            }, blobUrl) as string
            console.log(blobData)
            const printOutput = `${outputDir}/antecipado-${date.getFullYear()}-${date.getMonth() + 1}.pdf`
            await writeFile(printOutput, blobData.split(',')[1], 'base64')
            
            // Emite
            bar.update(i, { empresa: row.EMPRESA, status: 'Logout' })
            await page.evaluate(() => {
                // @ts-ignore
                localStorage.clear()
            })
        } catch (e: any) {
            console.error(e)
            console.error(`${row.EMPRESA}: ${e.message}`)
            await page.evaluate(() => {
                // @ts-ignore
                localStorage.clear()
            })
        }
    }
    
    bar.stop()
}

main()