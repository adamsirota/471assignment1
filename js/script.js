const margin = {top: 40, right: 30, bottom: 60, left: 70};
const width = 800 - margin.left - margin.right;
const mapHeight = 420 - margin.top - margin.bottom;
const scatterHeight = 450 - margin.top - margin.bottom;

let stations = [];
let selected = null; // null = nothing brushed; otherwise a Set of station names
let xScale, yScale, projection;
let mapBrush, scatterBrush, mapBrushG, scatterBrushG;

const mapSvg = d3.select('#map')
    .append('svg')
    .attr('width', width + margin.left + margin.right)
    .attr('height', mapHeight + margin.top + margin.bottom)
    .append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

const scatterSvg = d3.select('#scatter')
    .append('svg')
    .attr('width', width + margin.left + margin.right)
    .attr('height', scatterHeight + margin.top + margin.bottom)
    .append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

function init() {
    d3.csv('./data/weather.csv', function (d) {
        return {
            station: d.station,
            state: d.state,
            lat: +d.latitude,
            lon: +d.longitude,
            tmax: d.TMAX === '' ? NaN : +d.TMAX,
            prcp: d.PRCP === '' ? NaN : +d.PRCP
        };
    })
    .then(data => {
        // Drop physically implausible temperature readings (sensor errors)
        const valid = data.filter(d => d.tmax >= -80 && d.tmax <= 140);

        stations = Array.from(
            d3.rollup(valid, v => ({
                station: v[0].station,
                state: v[0].state,
                lat: v[0].lat,
                lon: v[0].lon,
                tmax: d3.mean(v, d => d.tmax),
                prcp: d3.mean(v, d => d.prcp)
            }), d => d.station).values()
        );

        // geoAlbersUsa only covers the 50 states, so territories (GU, PR, ...) are dropped
        projection = d3.geoAlbersUsa()
            .fitExtent([[10, 10], [width - 10, mapHeight - 10]],
                {type: 'MultiPoint', coordinates: stations.map(d => [d.lon, d.lat])});
        stations.forEach(d => { d.xy = projection([d.lon, d.lat]); });
        stations = stations.filter(d => d.xy && Number.isFinite(d.tmax) && Number.isFinite(d.prcp));

        console.log(stations);
        drawMap();
        drawScatter();
        updateHighlight();
    })
    .catch(error => console.error('Error loading data:', error));
}

window.addEventListener('load', init);

function drawMap() {
    mapSvg.append('text')
        .attr('class', 'chart-title')
        .attr('x', 0)
        .attr('y', -15)
        .text('Station locations');

    mapBrush = d3.brush()
        .extent([[0, 0], [width, mapHeight]])
        .on('start brush end', mapBrushed);
    mapBrushG = mapSvg.append('g').call(mapBrush);

    // Dots are drawn after the brush so hovering them still shows the tooltip
    mapSvg.selectAll('.station')
        .data(stations, d => d.station)
        .join('circle')
        .attr('class', 'station')
        .attr('cx', d => d.xy[0])
        .attr('cy', d => d.xy[1])
        .attr('r', 3)
        .on('mouseover', showTooltip)
        .on('mouseout', hideTooltip);
}

function drawScatter() {
    xScale = d3.scaleLinear()
        .domain(d3.extent(stations, d => d.tmax))
        .nice()
        .range([0, width]);
    yScale = d3.scaleLinear()
        .domain([0, d3.max(stations, d => d.prcp)])
        .nice()
        .range([scatterHeight, 0]);

    scatterSvg.append('g')
        .attr('class', 'x-axis')
        .attr('transform', `translate(0,${scatterHeight})`)
        .call(d3.axisBottom(xScale));
    scatterSvg.append('g')
        .attr('class', 'y-axis')
        .call(d3.axisLeft(yScale));

    scatterSvg.append('text')
        .attr('class', 'axis-label')
        .attr('x', width / 2)
        .attr('y', scatterHeight + margin.bottom - 15)
        .attr('text-anchor', 'middle')
        .text('Average daily high temperature (°F)');
    scatterSvg.append('text')
        .attr('class', 'axis-label')
        .attr('transform', 'rotate(-90)')
        .attr('x', -scatterHeight / 2)
        .attr('y', -margin.left + 20)
        .attr('text-anchor', 'middle')
        .text('Average daily precipitation (in)');
    scatterSvg.append('text')
        .attr('class', 'chart-title')
        .attr('x', 0)
        .attr('y', -15)
        .text('Temperature vs. precipitation');

    scatterBrush = d3.brush()
        .extent([[0, 0], [width, scatterHeight]])
        .on('start brush end', scatterBrushed);
    scatterBrushG = scatterSvg.append('g').call(scatterBrush);

    scatterSvg.selectAll('.station')
        .data(stations, d => d.station)
        .join('circle')
        .attr('class', 'station')
        .attr('cx', d => xScale(d.tmax))
        .attr('cy', d => yScale(d.prcp))
        .attr('r', 3)
        .on('mouseover', showTooltip)
        .on('mouseout', hideTooltip);
}

function mapBrushed(event) {
    if (!event.sourceEvent) return; // ignore programmatic brush.move calls
    if (event.type === 'start') scatterBrushG.call(scatterBrush.move, null);
    selected = selectWithin(event.selection, d => d.xy);
    updateHighlight();
}

function scatterBrushed(event) {
    if (!event.sourceEvent) return;
    if (event.type === 'start') mapBrushG.call(mapBrush.move, null);
    selected = selectWithin(event.selection, d => [xScale(d.tmax), yScale(d.prcp)]);
    updateHighlight();
}

function selectWithin(selection, position) {
    if (!selection) return null;
    const [[x0, y0], [x1, y1]] = selection;
    return new Set(stations
        .filter(d => {
            const [x, y] = position(d);
            return x >= x0 && x <= x1 && y >= y0 && y <= y1;
        })
        .map(d => d.station));
}

function updateHighlight() {
    d3.selectAll('.station')
        .classed('dimmed', d => selected !== null && !selected.has(d.station));

    if (selected === null) {
        d3.select('#summary').text(`Showing all ${stations.length} stations.`);
    } else {
        const picked = stations.filter(d => selected.has(d.station));
        const avgHigh = d3.mean(picked, d => d.tmax);
        const avgPrcp = d3.mean(picked, d => d.prcp);
        d3.select('#summary').text(picked.length === 0
            ? 'No stations selected.'
            : `${picked.length} stations selected: avg high ${avgHigh.toFixed(1)}°F, avg precipitation ${avgPrcp.toFixed(3)} in/day.`);
    }
}

function showTooltip(event, d) {
    d3.select('#tooltip')
        .style('display', 'block')
        .html(`<strong>${d.station}</strong> (${d.state})<br/>
            Avg high: ${d.tmax.toFixed(1)}°F<br/>
            Avg precipitation: ${d.prcp.toFixed(3)} in/day`)
        .style('left', (event.pageX + 20) + 'px')
        .style('top', (event.pageY - 28) + 'px');
}

function hideTooltip() {
    d3.select('#tooltip').style('display', 'none');
}
