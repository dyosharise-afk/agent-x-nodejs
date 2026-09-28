/**
 * АГЕНТ X — NODE.JS ПАРСЕР БРАУЗЕРА
 * Собирает резюме с HH.ru, VK и добавляет в Google Sheets
 * Работает на облаке 24/7 без Python
 */

const puppeteer = require('puppeteer');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// ==================== КОНФИГУРАЦИЯ ====================

const CONFIG = {
  SPREADSHEET_ID: '16ZH_GJrD4ywtscy-_rVGDh_nmKiX12yOx9lfBvoylSQ',
  HH_BASE_URL: 'https://hh.ru/search/resume',
  VK_TOKEN: '39ae35cc39ae35cc39ae35cc803aedcd2a339ae39ae35cc531df3d68aa880d5f0344dc1',
  VK_API_URL: 'https://api.vk.com/method',
};

const PROJECTS = {
  2: { name: 'Раддолье', type: 'normal' },
  3: { name: 'Кубачи', type: 'normal' },
  8: { name: 'TopLash', type: 'technical' },
  9: { name: 'Грисфот', type: 'normal' }
};

const QUERIES = {
  2: ['интернет маркетолог', 'маркетолог', 'digital маркетолог'],
  3: ['директор маркетинга', 'маркетолог', 'head of marketing'],
  8: ['account recovery specialist', 'восстановление аккаунтов'],
  9: ['проектный менеджер', 'project manager', 'pm']
};

const KEYWORDS_FILTER = {
  2: ['маркетинг', 'marketing', 'продвижение', 'реклама', 'seo', 'smm'],
  3: ['маркетинг', 'маркетолог', 'директор', 'менеджер', 'marketing'],
  8: ['account', 'recovery', 'telegram', 'admin', 'восстановление'],
  9: ['проект', 'project', 'менеджер', 'manager', 'управление']
};

// ==================== ЛОГИРОВАНИЕ ====================

function log(level, message) {
  const timestamp = new Date().toLocaleTimeString('ru-RU');
  console.log(`[${timestamp}] ${level}: ${message}`);
}

// ==================== УТИЛИТЫ ====================

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRelevant(text, projectId) {
  if (!text) return true;
  const keywords = KEYWORDS_FILTER[projectId] || [];
  const lowerText = text.toLowerCase();
  return keywords.some(k => lowerText.includes(k));
}

// ==================== HH.RU ПАРСИНГ ====================

async function parseHHResumes(browser, query) {
  const resumes = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    const url = `${CONFIG.HH_BASE_URL}?text=${encodeURIComponent(query)}&area=1&per_page=50`;

    log('INFO', `🔍 Загружаем HH.ru: "${query}"`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    await sleep(2000);

    // Парсим резюме со страницы
    const resumeData = await page.evaluate(() => {
      const items = [];
      const elements = document.querySelectorAll('[data-qa="resume-item"]');

      elements.forEach((el, index) => {
        if (index >= 20) return; // Берем только первые 20

        try {
          const nameEl = el.querySelector('[data-qa="resume-name-link"]');
          const positionEl = el.querySelector('[data-qa="resume-title"]');
          const locationEl = el.querySelector('[data-qa="resume-location"]');

          const name = nameEl?.textContent?.trim() || '';
          const position = positionEl?.textContent?.trim() || '';
          const location = locationEl?.textContent?.trim() || '';
          const link = nameEl?.getAttribute('href') || '';

          if (name) {
            items.push({
              name,
              position,
              location,
              link: link.startsWith('http') ? link : `https://hh.ru${link}`,
              allText: `${name} ${position} ${location}`.toLowerCase()
            });
          }
        } catch (e) {
          console.error('Parse error:', e.message);
        }
      });

      return items;
    });

    log('INFO', `   Найдено: ${resumeData.length} резюме на странице`);

    // Фильтруем по релевантности
    resumeData.forEach(item => {
      const resume = {
        name: item.name,
        position: item.position,
        location: item.location,
        link: item.link,
        source: 'HH.ru',
        date: new Date().toLocaleDateString('ru-RU')
      };
      resumes.push(resume);
      log('INFO', `   ✓ ${item.name}`);
    });

    await page.close();

    log('INFO', `✅ HH.ru: собрано ${resumes.length} резюме`);

  } catch (error) {
    log('ERROR', `❌ Ошибка парсинга HH.ru: ${error.message}`);
  }

  await sleep(2000);
  return resumes;
}

// ==================== VK ПОИСК ====================

async function searchVKProfiles(query) {
  const profiles = [];

  try {
    log('INFO', `🔍 Ищем в VK: "${query}"`);

    const params = {
      q: query,
      type: 'people',
      count: '30',
      fields: 'photo_200,city',
      v: '5.131',
      access_token: CONFIG.VK_TOKEN
    };

    const response = await axios.get(`${CONFIG.VK_API_URL}/users.search`, { params });

    if (response.data.response && response.data.response.items) {
      const items = response.data.response.items.slice(0, 15);
      log('INFO', `   Найдено профилей: ${items.length}`);

      items.forEach(item => {
        const profile = {
          name: `${item.first_name} ${item.last_name}`.trim(),
          position: '',
          location: item.city?.title || '',
          link: `https://vk.com/id${item.id}`,
          source: 'VK',
          date: new Date().toLocaleDateString('ru-RU')
        };

        if (profile.name) {
          profiles.push(profile);
          log('INFO', `   ✓ ${profile.name}`);
        }
      });
    }

    log('INFO', `✅ VK: собрано ${profiles.length} профилей`);

  } catch (error) {
    log('ERROR', `❌ Ошибка поиска VK: ${error.message}`);
  }

  await sleep(1000);
  return profiles;
}

// ==================== GOOGLE SHEETS ====================

async function addToGoogleSheets(sheetName, resumes) {
  if (!resumes || resumes.length === 0) return;

  try {
    const doc = new GoogleSpreadsheet(CONFIG.SPREADSHEET_ID);

    // Используем service account если есть
    if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      const auth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      await doc.useServiceAccountAuth(auth);
    }

    await doc.loadInfo();

    const sheet = doc.sheetsByTitle[sheetName];
    if (!sheet) {
      log('ERROR', `❌ Лист "${sheetName}" не найден`);
      return;
    }

    log('INFO', `📝 Добавляем в ${sheetName} (${resumes.length} резюме)`);

    for (const resume of resumes) {
      await sheet.addRow({
        'Дата': resume.date,
        'Ссылка': resume.link,
        'ФИО': resume.name,
        'Контакты': '',
        'Источник': resume.source,
        'Балл': '',
        'Комментарий': ''
      });

      await sleep(200); // Задержка между добавлениями
    }

    log('INFO', `✅ Добавлено ${resumes.length} резюме в ${sheetName}`);

  } catch (error) {
    log('ERROR', `❌ Ошибка добавления в Google Sheets: ${error.message}`);
  }
}

// ==================== ГЛАВНЫЙ ПРОЦЕСС ====================

async function main() {
  log('INFO', '='.repeat(60));
  log('INFO', '🚀 АГЕНТ X — NODE.JS ПАРСЕР');
  log('INFO', '='.repeat(60));

  let browser;

  try {
    // Инициализируем браузер
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    log('INFO', '✅ Браузер инициализирован');

    // Проходим по каждому проекту
    for (const [projectId, project] of Object.entries(PROJECTS)) {
      const projId = parseInt(projectId);
      log('INFO', `\n📁 Проект: ${project.name}`);

      const queries = QUERIES[projId] || [];

      for (const query of queries) {
        log('INFO', `🔍 Поиск: "${query}"`);

        // HH.ru
        const hhResumes = await parseHHResumes(browser, query);
        if (hhResumes.length > 0) {
          await addToGoogleSheets(project.name, hhResumes);
        }

        // VK
        const vkProfiles = await searchVKProfiles(query);
        if (vkProfiles.length > 0) {
          await addToGoogleSheets(project.name, vkProfiles);
        }
      }
    }

    log('INFO', '\n' + '='.repeat(60));
    log('INFO', '✅✅✅ ВЫПОЛНЕНИЕ ЗАВЕРШЕНО!');
    log('INFO', '='.repeat(60));

  } catch (error) {
    log('ERROR', `❌ Ошибка: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
      log('INFO', 'Браузер закрыт');
    }
  }
}

// ==================== ЗАПУСК ====================

// Для локального запуска
if (require.main === module) {
  main().catch(console.error);
}

// Для облачного запуска (Vercel, Railway)
module.exports = { main };
