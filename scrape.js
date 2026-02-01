import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const LEAGUES = [
  {
    id: 'premier-league',
    name: 'Premier League',
    url: 'https://www.livesport.cz/fotbal/anglie/premier-league/vysledky/',
    country: 'anglie'
  },
  {
    id: 'ligue-1',
    name: 'Ligue 1',
    url: 'https://www.livesport.cz/fotbal/francie/ligue-1/vysledky/',
    country: 'francie'
  },
  {
    id: 'serie-a',
    name: 'Serie A',
    url: 'https://www.livesport.cz/fotbal/italie/serie-a/vysledky/',
    country: 'italie'
  },
  {
    id: 'bundesliga',
    name: 'Bundesliga',
    url: 'https://www.livesport.cz/fotbal/nemecko/bundesliga/vysledky/',
    country: 'nemecko'
  },
  {
    id: 'laliga',
    name: 'La Liga',
    url: 'https://www.livesport.cz/fotbal/spanelsko/laliga/vysledky/',
    country: 'spanelsko'
  }
];

async function scrapeLeagueMatches(page, league) {
  console.log(`Scraping ${league.name}...`);
  
  try {
    await page.goto(league.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Get matches from last 5 rounds
    const matches = await page.evaluate(() => {
      const matchData = [];
      const rounds = document.querySelectorAll('.sportName.soccer');
      
      let roundCount = 0;
      for (let round of rounds) {
        if (roundCount >= 5) break;
        
        let currentElement = round.nextElementSibling;
        while (currentElement && !currentElement.classList.contains('sportName')) {
          if (currentElement.classList.contains('event__match')) {
            const homeTeam = currentElement.querySelector('.event__participant--home')?.textContent.trim();
            const awayTeam = currentElement.querySelector('.event__participant--away')?.textContent.trim();
            const scoreHome = currentElement.querySelector('.event__score--home')?.textContent.trim();
            const scoreAway = currentElement.querySelector('.event__score--away')?.textContent.trim();
            const matchId = currentElement.getAttribute('id')?.replace('g_1_', '');
            
            if (homeTeam && awayTeam && scoreHome && scoreAway && matchId) {
              matchData.push({
                homeTeam,
                awayTeam,
                scoreHome: parseInt(scoreHome),
                scoreAway: parseInt(scoreAway),
                matchId
              });
            }
          }
          currentElement = currentElement.nextElementSibling;
        }
        roundCount++;
      }
      
      return matchData;
    });

    console.log(`Found ${matches.length} matches for ${league.name}`);

    // Get odds for each match
    for (let match of matches) {
      try {
        const oddsUrl = `https://www.livesport.cz/zapas/${match.matchId}/kurzy/draw-no-bet/zakladni-doba/`;
        await page.goto(oddsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(2000);

        const odds = await page.evaluate(() => {
          const oddsElements = document.querySelectorAll('.ui-table__row');
          let homeOdds = null;
          let awayOdds = null;

          for (let row of oddsElements) {
            const cells = row.querySelectorAll('.ui-table__cell');
            if (cells.length >= 3) {
              const label = cells[0]?.textContent.trim();
              if (label === '1' && !homeOdds) {
                homeOdds = parseFloat(cells[1]?.textContent.trim());
              }
              if (label === '2' && !awayOdds) {
                awayOdds = parseFloat(cells[1]?.textContent.trim());
              }
            }
          }

          return { homeOdds, awayOdds };
        });

        match.homeOdds = odds.homeOdds;
        match.awayOdds = odds.awayOdds;
        
        console.log(`${match.homeTeam} vs ${match.awayTeam}: ${match.homeOdds} / ${match.awayOdds}`);
      } catch (error) {
        console.error(`Error getting odds for match ${match.matchId}:`, error.message);
      }
    }

    return matches;
  } catch (error) {
    console.error(`Error scraping ${league.name}:`, error.message);
    return [];
  }
}

function calculateVSV(teamMatches, teamName) {
  let totalStakes = 0;
  let totalReturns = 0;
  let favoriteCount = 0;
  let outsiderCount = 0;

  for (let match of teamMatches) {
    // Skip matches without odds or draws
    if (!match.teamOdds || !match.opponentOdds || match.isDraw) continue;

    const isFavorite = match.teamOdds < match.opponentOdds;
    const stake = isFavorite ? 100 : 50;
    
    totalStakes += stake;

    if (isFavorite) {
      favoriteCount++;
    } else {
      outsiderCount++;
    }

    if (match.teamWon) {
      totalReturns += stake * match.teamOdds;
    }
  }

  const vsv = totalStakes > 0 ? ((totalReturns - totalStakes) / totalStakes) * 100 : 0;

  return {
    totalStakes,
    totalReturns,
    vsv,
    favoriteCount,
    outsiderCount
  };
}

function processMatches(matches, league) {
  const teamStats = new Map();

  for (let match of matches) {
    // Skip matches without odds
    if (!match.homeOdds || !match.awayOdds) continue;

    const isDraw = match.scoreHome === match.scoreAway;

    // Process home team
    if (!teamStats.has(match.homeTeam)) {
      teamStats.set(match.homeTeam, []);
    }
    teamStats.get(match.homeTeam).push({
      teamOdds: match.homeOdds,
      opponentOdds: match.awayOdds,
      teamWon: match.scoreHome > match.scoreAway,
      isDraw: isDraw
    });

    // Process away team
    if (!teamStats.has(match.awayTeam)) {
      teamStats.set(match.awayTeam, []);
    }
    teamStats.get(match.awayTeam).push({
      teamOdds: match.awayOdds,
      opponentOdds: match.homeOdds,
      teamWon: match.scoreAway > match.scoreHome,
      isDraw: isDraw
    });
  }

  const teams = [];
  for (let [teamName, teamMatches] of teamStats) {
    const stats = calculateVSV(teamMatches, teamName);
    teams.push({
      name: teamName,
      league: league.name,
      leagueId: league.id,
      ...stats
    });
  }

  return teams;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let browser = null;

  try {
    console.log('Starting browser...');
    
    // For development
    if (process.env.NODE_ENV === 'development') {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    } else {
      // For production (Vercel)
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    }

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let allTeams = [];

    for (let league of LEAGUES) {
      const matches = await scrapeLeagueMatches(page, league);
      const teams = processMatches(matches, league);
      allTeams = allTeams.concat(teams);
    }

    // Sort by VSV descending
    allTeams.sort((a, b) => b.vsv - a.vsv);

    await browser.close();

    res.status(200).json({
      success: true,
      teams: allTeams,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Scraping error:', error);
    
    if (browser) {
      await browser.close();
    }

    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
    responseLimit: false,
  },
  maxDuration: 300, // 5 minutes for Vercel Pro
};