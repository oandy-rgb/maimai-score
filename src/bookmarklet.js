(function () {
    const SCORE_URLS = [
        { diff: 'BASIC',    url: '/maimai-mobile/record/musicGenre/search/?genre=99&diff=0' },
        { diff: 'ADVANCED', url: '/maimai-mobile/record/musicGenre/search/?genre=99&diff=1' },
        { diff: 'EXPERT',   url: '/maimai-mobile/record/musicGenre/search/?genre=99&diff=2' },
        { diff: 'MASTER',   url: '/maimai-mobile/record/musicGenre/search/?genre=99&diff=3' },
        { diff: 'REMASTER', url: '/maimai-mobile/record/musicGenre/search/?genre=99&diff=4' },
    ]

    function parseRows(html, difficulty) {
        const parser = new DOMParser()
        const dom = parser.parseFromString(html, 'text/html')
        const rows = dom.querySelectorAll('.w_450.m_15')
        const scores = []

        rows.forEach(row => {
            const titleEl = row.querySelector('.music_name_block')
            const levelEl = row.querySelector('.music_lv_block')
            const achievementEl = row.querySelector('.music_score_block.w_112')
            if (!titleEl || !achievementEl) return

                const chartTypeImg = row.querySelector('img.music_kind_icon')
                const chartType = chartTypeImg?.src.includes('music_dx') ? 'DX' : 'STANDARD'
                const achievement = parseFloat(achievementEl.innerText.replace('%', ''))

                scores.push({
                    title: titleEl.innerText.trim(),
                            level: levelEl?.innerText.trim() ?? '',
                            difficulty,
                            chart_type: chartType,
                            achievement,
                })
        })

        return scores
    }

    async function fetchAllScores() {
        const host = location.host
        if (host !== 'maimaidx-eng.com' && host !== 'maimaidx.jp') {
            alert('請在 maimai NET 頁面使用此書籤')
            return
        }

        const allScores = []
        for (const { diff, url } of SCORE_URLS) {
            console.log(`抓取 ${diff}...`)
            const res = await fetch(url)
            const html = await res.text()
            const scores = parseRows(html, diff)
            allScores.push(...scores)
            console.log(`${diff} 完成，共 ${scores.length} 筆`)
        }

        console.log(`全部完成，共 ${allScores.length} 筆成績`)
        console.log(allScores)

        // 送到 Hono API
        await fetch('https://api.o-andy.com/api/scores/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('session_token') ?? ''}`,
            },
            body: JSON.stringify(allScores),
        })

        alert(`同步完成，共 ${allScores.length} 筆成績`)
    }

    fetchAllScores()
})()
