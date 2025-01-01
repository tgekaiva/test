const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');

// Use the stealth plugin to bypass bot detection
puppeteer.use(StealthPlugin());

// Function to create a delay using Promise-based setTimeout
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to navigate with retries
async function navigateWithRetry(page, url, retries = 5, timeout = 90000) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout });
      return;
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`Retrying navigation due to error: ${error.message}`);
      await delayFunction(2000);
    }
  }
}

// Function to read user agents from a file
function readUserAgentsFromFile(filePath) {
  try {
    const userAgentData = fs.readFileSync(filePath, 'utf8');
    const userAgents = userAgentData.split('\n').map(line => line.trim()).filter(Boolean);
    console.log(`Loaded ${userAgents.length} user agents from the file.`);
    return userAgents;
  } catch (error) {
    console.error(`Error reading user agent file: ${error.message}`);
    return [];
  }
}

// Function to read proxies from a file
function readProxiesFromFile(filePath) {
  try {
    const proxyData = fs.readFileSync(filePath, 'utf8');
    const proxies = proxyData.split('\n').map((line, index) => {
      if (!line.trim()) return null;

      const [credentials, ipPort] = line.split('@');
      if (!credentials || !ipPort) return null;

      const [username, password] = credentials.split(':');
      const [ip, port] = ipPort.split(':');
      return { username, password, ip, port };
    }).filter(proxy => proxy !== null);

    console.log(`Loaded ${proxies.length} valid proxies from the file.`);
    return proxies;
  } catch (error) {
    console.error(`Error reading proxy file: ${error.message}`);
    return [];
  }
}

// Function to start browser automation with batching
async function startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, headless) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D',
  };

  const filterParam = filterMap[filter] || '';
  const batchSize = 10;

  for (let start = 0; start < windows; start += batchSize) {
    const batchWindows = Math.min(batchSize, windows - start);

    const browserPromises = [];
    for (let i = 0; i < batchWindows; i++) {
      const index = start + i;
      const proxy = useProxies ? proxies[index % proxies.length] : null;
      const userAgent = userAgents[index % userAgents.length];
      browserPromises.push(
        openWindow(index, query, filterParam, useProxies, proxy, userAgent, channelName, headless)
      );
    }

    await Promise.allSettled(browserPromises);
  }
}

// Function to open a single browser window and track video playback
async function openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless) {
  try {
    const navigationTimeout = useProxies ? 900000 : 90000;

    const browser = await puppeteer.launch({
      headless: headless,
      executablePath: '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-infobars',
        '--window-size=1024,600',
        '--disable-blink-features=AutomationControlled',
        '--disable-software-rasterizer',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      defaultViewport: { width: 1024, height: 600 },
      timeout: 70000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    if (useProxies && proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await page.setDefaultNavigationTimeout(navigationTimeout);
    console.log(`Window ${i + 1}: Navigating to YouTube homepage.`);
    await navigateWithRetry(page, 'https://www.youtube.com', 5, 90000);

    console.log(`Window ${i + 1}: Searching for "${query}".`);
    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

    console.log(`Window ${i + 1}: Waiting for search results to load.`);
    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });

    console.log(`Window ${i + 1}: Adding delay before applying the filter.`);
    await delayFunction(1987);
    await page.click('button[aria-label="Search filters"]');
    await delayFunction(2398);

    console.log(`Window ${i + 1}: Applying filter "${filterParam}".`);
    const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
    await page.goto(newUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });
    await scrollPage(page);

    console.log(`Window ${i + 1}: Clicking on the first video.`);
    const videoSelector = 'ytd-video-renderer #video-title';
    await page.waitForSelector(videoSelector, { visible: true, timeout: navigationTimeout });
    const firstVideo = await page.$(videoSelector);
    await firstVideo.click();

    console.log(`Window ${i + 1}: Waiting for video to load.`);
    await page.waitForSelector('video', { visible: true, timeout: navigationTimeout });

    console.log(`Window ${i + 1}: Waiting for video playback to start.`);
    await trackVideoPlayback(page, i, browser);
  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
  }
}

// Function to track video playback and close window when finished
async function trackVideoPlayback(page, windowIndex, browser) {
  let currentTime = 0;
  let totalDuration = 0;

  let videoStarted = false;
  while (!videoStarted) {
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement && videoElement.duration > 0) {
        return {
          currentTime: videoElement.currentTime,
          totalDuration: videoElement.duration,
        };
      }
      return { currentTime: 0, totalDuration: 0 };
    });

    currentTime = videoData.currentTime;
    totalDuration = videoData.totalDuration;

    if (currentTime > 0) {
      videoStarted = true;
    } else {
      await delayFunction(2000);
    }
  }

  while (currentTime < totalDuration) {
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement) {
        return {
          currentTime: videoElement.currentTime || 0,
          totalDuration: videoElement.duration || 0,
        };
      }
      return { currentTime: 0, totalDuration: 0 };
    });

    currentTime = videoData.currentTime || 0;
    totalDuration = videoData.totalDuration || 0;

    console.log(
      `Window ${windowIndex + 1}: ${currentTime.toFixed(2)} / ${totalDuration.toFixed(2)} seconds`
    );

    await delayFunction(3000);
  }

  console.log(`Window ${windowIndex + 1}: Video finished. Closing browser.`);
  await browser.close();
}

// Function to randomly scroll the page
async function scrollPage(page) {
  console.log('Scrolling randomly.');
  await delayFunction(3000);

  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);

  const randomScrollDown = Math.floor(Math.random() * (scrollHeight / 2)) + 100;
  console.log(`Scrolling down by ${randomScrollDown}px`);
  await page.evaluate(scrollPos => window.scrollTo(0, scrollPos), randomScrollDown);

  await delayFunction(3897);
  console.log('Forcing scroll to the top');
  await page.evaluate(() => window.scrollTo(0, 0));
  await delayFunction(3786);
}

// Humanized typing delay
async function humanizedType(page, selector, text) {
  for (const char of text) {
    await page.type(selector, char);
    await delayFunction(Math.random() * 100 + 50);
  }
}

// Main execution block
(async () => {
  console.log('Starting the YouTube search automation.');
  const { query, windows, useProxies, filter, headless } = await inquirer.prompt([
    { type: 'input', name: 'query', message: 'Enter search query:' },
    { type: 'number', name: 'windows', message: 'Enter number of windows to open:' },
    { type: 'confirm', name: 'useProxies', message: 'Do you want to use proxies?' },
    { type: 'list', name: 'filter', message: 'Select search filter:', choices: ['None', 'Last hour', 'Today', 'This week'] },
    { type: 'confirm', name: 'headless', message: 'Run in headless mode?' },
  ]);

  const userAgents = readUserAgentsFromFile(path.join(__dirname, 'user_agents.txt'));
  const proxies = useProxies ? readProxiesFromFile(path.join(__dirname, 'proxies.txt')) : [];

  const channelName = query.toLowerCase().replace(/\s/g, '-');
  await startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, headless);
})();
