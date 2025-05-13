import puppeteer, { ElementHandle, Page, BoundingBox, Viewport } from "puppeteer"
import fs from 'fs/promises'
import cliProgress from 'cli-progress'
import path from 'path'
import { Command } from "commander";
import { mkdir, writeFile } from 'fs/promises'
import { situacoesSelect } from "./situacoes-select";

const situacao: keyof typeof situacoesSelect = 'todos'
const enablePreviousMonth = true;

const program = new Command()

program
    .version("1.0.0")
    .description("Contab Notas de Entrada")
    .option("-o, --output <output path>", "Caminho da saída")
    .parse(process.argv)

const options = program.opts()
const outputBasePath = options.output ? [options.output] : [__dirname, 'output']

function screenshot(output: string, page: any, cardBoundingBox: BoundingBox, viewport: Viewport) {
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

async function waitForTargetDownload(page: Page) {
    const newTarget = await page.browserContext().waitForTarget(
        target => target.url().startsWith('blob:')
    )
    const newPage = await newTarget.page() as Page
    const blobUrl = newPage.url()
    const blobData = await page.evaluate(async (url) => {
        const response = await fetch(url)
        const blob = await response.blob()

        // @ts-ignore
        const reader = new FileReader()
        return new Promise(resolve => {
            reader.onloadend = () => {
                resolve(reader.result)
            }
            reader.readAsDataURL(blob)
        }
        )
    }, blobUrl) as string

    await newPage.close()

    return blobData
}

async function waitForDownload(page: Page) {
    await page.waitForNetworkIdle()
    await page.waitForSelector('.black-overlay', { hidden: true, timeout: 60000 })
    await new Promise(r => setTimeout(r, 1000))
}

export async function main() {
    const bar = new cliProgress.SingleBar({
        format: ' {bar} | {empresa}: {status} | {value}/{total}'
    }, cliProgress.Presets.shades_classic)

    // Parse companies CSV
    const csv = await fs.readFile(__dirname + '/input.csv', { encoding: 'utf-8' })
    const rows = csv.split('\n').map(r => r.split(';'))
    const data = rows.slice(1).map(row => Object.fromEntries(row.map((value, i) => [rows[0][i], value])))

    // Launch browser
    const browser = await puppeteer.launch({ headless: false, })
    const page = await browser.newPage()

    bar.start(Object.keys(data).length, 0)
    var i = 0;
    for (const row of data) {
        const empresaKey = Object.keys(row)[0]
        try {
            i = i + 1
            bar.update(i, { empresa: row[empresaKey], status: 'Autenticando' })

            // Sign In
            await page.goto('https://contribuinte.sefaz.al.gov.br/cobrancadfe/#/calculo-nfe')

            await page.waitForNavigation()
            await page.waitForSelector('#username')
            await page.type('#username', row.LOGIN)
            await page.type('#password', row.SENHA)

            await page.click('form button[type=submit]')
            await page.waitForNavigation();
            const userLoggedSelector = '#logout';
            const authErrorSelector = '.alert.alert-danger'

            await Promise.race([
                page.waitForSelector(userLoggedSelector),
                page.waitForSelector(authErrorSelector)
            ])

            const authSuccess = Boolean(await page.$(userLoggedSelector))

            if (!authSuccess) {
                await page.setViewport({ width: 1600, height: 500, })
                const card = await page.$('.card') as ElementHandle
                const cardBoundingBox = await card.boundingBox() as BoundingBox
                const viewport = page.viewport() as Viewport
                const screenshotOutput = `${outputBasePath}/auth-error/${row[empresaKey]}.png`
                await screenshot(screenshotOutput, page, cardBoundingBox, viewport)

                continue;
            }

            const queryDates: Date[] = []
            let date = new Date()
            date.setDate(0)
            queryDates.push(date)

            // If is type SN, query previous month
            if (row.TIPO == 'SN' && enablePreviousMonth) {
                let date2 = new Date()
                date2.setDate(0)
                date2.setDate(0)
                queryDates.push(date2)
            }

            bar.update(i, { empresa: row[empresaKey], status: 'Pesquisando Antecipado', })

            // Get CNPJ
            const cnpjElement = (await page.waitForSelector('.alert.alert-data')) as ElementHandle
            const cnpjText = await (await cnpjElement.getProperty('textContent')).jsonValue() as string
            const cnpj = cnpjText.replace(/[^\d]/g, '')

            for (const date of queryDates) {
                // Apply query
                bar.update(i, { empresa: row[empresaKey], status: 'Pesquisando Antecipado', })
                await page.waitForNetworkIdle()
                const dataButton = await page.waitForSelector(`#pickerForm .row div.col-4:nth-child(${date.getMonth() + 4}) span`) as ElementHandle
                await dataButton.evaluate((button: any) => button.click())

                if (situacao != 'em-aberto') {
                    await page.waitForNetworkIdle()
                    const situacaoSelect = situacoesSelect[situacao]
                    const result = await page.evaluate(() => {
                        // @ts-ignore
                        document.querySelector('#situacoes-select').dispatchEvent(new Event('input', { bubbles: true }));
                    })

                    const situacaoButton = await page.waitForSelector(situacaoSelect)
                    await situacaoButton?.click()
                }

                await page.click('button[type=submit]')

                await waitForDownload(page)
                // Screenshot
                bar.update(i, { empresa: row[empresaKey], status: 'Salvando print', })
                await page.setViewport({ width: 1600, height: 500, })
                const card = await page.$('.card') as ElementHandle
                const cardBoundingBox = await card.boundingBox() as BoundingBox
                const viewport = page.viewport() as Viewport
                const outputDir = path.join(...outputBasePath, `${row[empresaKey]} - ${cnpj}`)
                await mkdir(outputDir, { recursive: true }).catch(_ => { })

                const screenshotOutput = `${outputDir}/antecipado-${date.getFullYear()}-${date.getMonth() + 1}.png`
                await screenshot(screenshotOutput, page, cardBoundingBox, viewport)

                const hasDocs = !!(await page.$('body > jhi-main > div.container-fluid > div > jhi-calculo-nfe > div > div:nth-child(7) > div:nth-child(3) > div > div > div > div:nth-child(1) > button'))
                bar.update(i, { empresa: row[empresaKey], status: hasDocs ? 'Tem documentos' : 'Não tem documentos', })
                if (hasDocs) {
                    await page.evaluate(() => {
                        // @ts-ignore
                        document.querySelector('#checkall').click()
                    })

                    // Print
                    bar.update(i, { empresa: row[empresaKey], status: 'Imprimindo', })
                    await page.evaluate(() => {
                        // @ts-ignore
                        document.querySelector('body > jhi-main > div.container-fluid > div > jhi-calculo-nfe > div > div:nth-child(7) > div:nth-child(2) > div > div > div > div:nth-child(2) > button').click()
                    })

                    const printOutput = `${outputDir}/antecipado-${date.getFullYear()}-${date.getMonth() + 1}.pdf`
                    const blobData = await waitForTargetDownload(page)
                    await writeFile(printOutput, blobData.split(',')[1], 'base64')

                    // Emite
                    bar.update(i, { empresa: row[empresaKey], status: 'Emitindo', })
                    await page.evaluate(() => {
                        // @ts-ignore
                        document.querySelector('body > jhi-main > div.container-fluid > div > jhi-calculo-nfe > div > div:nth-child(7) > div:nth-child(3) > div > div > div > div:nth-child(2) > button').click()
                    })

                    await page.evaluate(() => {
                        // @ts-ignore
                        document.querySelector('body > ngb-modal-window > div > div > jhi-confirmar-emissao-dar-consolidado > div.modal-body.container-tidy button.btn.btn-outline-success').click()
                    })

                    try {
                        const emissaoOutput = `${outputDir}/doc-arrecadacao-${date.getFullYear()}-${date.getMonth() + 1}.pdf`
                        const data = await waitForTargetDownload(page)
                        await writeFile(emissaoOutput, data.split(',')[1], 'base64')
                    } catch (e) {
                        await page.evaluate(() => {
                            // @ts-ignore
                            document.querySelector('body > ngb-modal-window > div > div > jhi-escolher-vencimento-dar > div.modal-body.container-tidy > div.text-center.my-3 > button.btn.btn-outline-success').click()
                        })
                        const emissaoOutput = `${outputDir}/doc-arrecadacao-${date.getFullYear()}-${date.getMonth() + 1}.pdf`
                        const data = await waitForTargetDownload(page)
                        await writeFile(emissaoOutput, data.split(',')[1], 'base64')
                    }
                }
            }

            bar.update(i, { empresa: row[empresaKey], status: 'Logout' })
            await page.evaluate(() => {
                // @ts-ignore
                localStorage.clear()
                // @ts-ignore
                sessionStorage.clear()
            })
            await page.goto('about:blank')
        } catch (e: any) {
            console.error(e)
            console.error(`${row[empresaKey]}: ${e.message}`)
            await page.evaluate(() => {
                // @ts-ignore
                localStorage.clear()
                // @ts-ignore
                sessionStorage.clear()
            })
            await page.goto('about:blank')
        }
    }

    bar.stop()
}

main()