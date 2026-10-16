const margin = {top: 40, right: 30, bottom: 60, left: 70};
const width = 800 - margin.left - margin.right;
const mapHeight = 420 - margin.top - margin.bottom;
const scatterHeight = 450 - margin.top - margin.bottom;
const usStates = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
    'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
    'DC'
]);
const legendWidth = 150;
const legendHeight = 10;

let stations = [], statesData;
let selected = null; // null = nothing brushed; otherwise a Set of station names
let xScale, yScale, projection, colorScale;
let mapBrush, scatterBrush, mapBrushG, scatterBrushG, annotationG;
let zoom, panMode = false;
let mapTransform = d3.zoomIdentity;
let mapStateLayer, mapDotLayer;

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
    Promise.all([
        d3.csv('./data/weather.csv', function (d) {
            return {
                station: d.station,
                state: d.state,
                lat: +d.latitude,
                lon: +d.longitude,
                tmax: d.TMAX === '' ? NaN : +d.TMAX,
                prcp: d.PRCP === '' ? NaN : +d.PRCP
            };
        }),
        d3.json('./data/basemap.json')
    ])
    .then(([data,us]) => {
        statesData = us;

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
        stations = stations.filter(d => usStates.has(d.state));


        // geoAlbersUsa only covers the 50 states, so territories (GU, PR, ...) are dropped
        projection = d3.geoAlbersUsa()
            .fitExtent([[10, 10], [width - 10, mapHeight - 10]],
                {type: 'MultiPoint', coordinates: stations.map(d => [d.lon, d.lat])});
        stations.forEach(d => { d.xy = projection([d.lon, d.lat]); });
        stations = stations.filter(d => d.xy && Number.isFinite(d.tmax) && 
            Number.isFinite(d.prcp) && usStates.has(d.state));

        colorScale = d3.scaleSequential()
            .domain(d3.extent(stations, d => d.tmax))
            .interpolator(t => d3.interpolateYlOrRd(0.2 + 0.8 * t));

        console.log(stations);
        drawMap();
        drawScatter();
        updateHighlight();

        d3.select('#reset')
            .on('click', () => setSelection(null));

        d3.select('#hottest')
            .on('click', () => selectPercentile('tmax', 0.9, true));

        d3.select('#coldest')
            .on('click', () => selectPercentile('tmax', 0.1, false));

        d3.select('#wettest')
            .on('click', () => selectPercentile('prcp', 0.9, true));

        d3.select('#pan-toggle')
            .on('click', function() {
                panMode = !panMode;

                mapBrushG.style('display', panMode ? 'none' : null);

                d3.select(this)
                    .classed('active', panMode)
                    .attr('aria-pressed', panMode)
                    .text(panMode ? 'Pan & zoom: On' : 'Pan & zoom');

                mapSvg.classed('pan-mode', panMode);

                // Remove any existing brush rectangle when switching modes
                mapBrushG.call(mapBrush.move, null);
            });

        d3.select('#reset-view')
            .on('click', () => {
                mapSvg.transition()
                    .duration(500)
                    .call(zoom.transform, d3.zoomIdentity);
            });
    })
    .catch(error => console.error('Error loading data:', error));
}

window.addEventListener('load', init);

function drawMap() {
    const path = d3.geoPath(projection);
    const states = topojson.feature(statesData, statesData.objects.states).features;
    const defs = mapSvg.append('defs');
    defs.append('clipPath')
        .attr('id', 'map-clip')
        .append('rect')
        .attr('width', width)
        .attr('height', mapHeight);
    
    const [minTemp, maxTemp] = colorScale.domain();
    const gradient = defs.append('linearGradient')
        .attr('id', 'temperature-gradient')
        .attr('x1', '0%')
        .attr('x2', '100%')
        .attr('y1', '0%')
        .attr('y2', '0%');

    gradient.selectAll('stop')
        .data(d3.range(0, 1.001, 0.1))
        .join('stop')
        .attr('offset', d => `${d * 100}%`)
        .attr('stop-color', d => colorScale(minTemp + d * (maxTemp - minTemp)));
    
    mapSvg.append('rect')
        .attr('class', 'map-capture')
        .attr('width', width)
        .attr('height', mapHeight)
        .attr('fill', 'none')
        .attr('pointer-events', 'all');
    
    const clippedMap = mapSvg.append('g').attr('clip-path', 'url(#map-clip)');
    mapStateLayer = clippedMap.append('g').attr('class', 'map-state-layer');

    mapStateLayer.selectAll('.state')
        .data(states)
        .join('path')
        .attr('class', 'state')
        .attr('d', path);
        
    mapSvg.append('text')
        .attr('class', 'chart-title')
        .attr('x', 0)
        .attr('y', -15)
        .text('Station locations');


    const legend = mapSvg.append('g')
        .attr('class', 'temperature-legend')
        .attr('transform', `translate(${width - legendWidth}, -20)`);

    legend.append('rect')
        .attr('width', legendWidth)
        .attr('height', legendHeight)
        .attr('fill', 'url(#temperature-gradient)');

    const legendScale = d3.scaleLinear()
        .domain([minTemp, maxTemp])
        .range([0, legendWidth]);
    
    legend.append('g')
        .attr('transform', `translate(0, ${legendHeight})`)
        .call(d3.axisBottom(legendScale).ticks(4));
    
    legend.append('text')
        .attr('x', legendWidth / 2)
        .attr('y', -6)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px')
        .text('Average daily high (°F)');

    mapBrush = d3.brush()
        .extent([[0, 0], [width, mapHeight]])
        .on('start brush end', mapBrushed);
    mapBrushG = mapSvg.append('g').call(mapBrush);

    const clippedDots = mapSvg.append('g').attr('clip-path', 'url(#map-clip)');

    mapDotLayer = clippedDots.append('g').attr('class', 'map-dot-layer');

    mapDotLayer.selectAll('.station')
        .data(stations, d => d.station)
        .join('circle')
        .attr('class', 'station')
        .attr('cx', d => d.xy[0])
        .attr('cy', d => d.xy[1])
        .attr('r', 3)
        .attr('fill', d => colorScale(d.tmax))
        .on('mouseover', showTooltip)
        .on('mouseout', hideTooltip);
    
    zoom = d3.zoom()
        .scaleExtent([1, 8])
        .extent([[0, 0], [width, mapHeight]])
        .translateExtent([[0, 0], [width, mapHeight]])
        .filter(event =>
            panMode &&
            !event.button &&
            (!event.ctrlKey || event.type === 'wheel')
        )
        .on('zoom', zoomed);

    mapSvg.call(zoom);

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
    
    const [minTemp, maxTemp] = colorScale.domain();
    const defs = scatterSvg.append('defs');
    const gradient = defs.append('linearGradient')
        .attr('id', 'temperature-gradient-scatter')
        .attr('x1', '0%')
        .attr('x2', '100%')
        .attr('y1', '0%')
        .attr('y2', '0%');

    gradient.selectAll('stop')
        .data(d3.range(0, 1.001, 0.1))
        .join('stop')
        .attr('offset', d => `${d * 100}%`)
        .attr('stop-color', d => colorScale(minTemp + d * (maxTemp - minTemp)));

    const legend = scatterSvg.append('g')
        .attr('class', 'temperature-legend')
        .attr('transform', `translate(${width - legendWidth}, -20)`);

    legend.append('rect')
        .attr('width', legendWidth)
        .attr('height', legendHeight)
        .attr('fill', 'url(#temperature-gradient-scatter)');

    const legendScale = d3.scaleLinear()
        .domain([minTemp, maxTemp])
        .range([0, legendWidth]);
    
    legend.append('g')
        .attr('transform', `translate(0, ${legendHeight})`)
        .call(d3.axisBottom(legendScale).ticks(4));
    
    legend.append('text')
        .attr('x', legendWidth / 2)
        .attr('y', -6)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px')
        .text('Average daily high (°F)');

    scatterSvg.selectAll('.station')
        .data(stations, d => d.station)
        .join('circle')
        .attr('class', 'station')
        .attr('cx', d => xScale(d.tmax))
        .attr('cy', d => yScale(d.prcp))
        .attr('r', 3)
        .attr('fill', d => colorScale(d.tmax))
        .on('mouseover', showTooltip)
        .on('mouseout', hideTooltip);
    
    const annotations = [
        {
            station: d3.greatest(stations, d => d.tmax),
            label: 'Hottest'
        },
        {
            station: d3.least(stations, d => d.tmax),
            label: 'Coldest'
        },
        {
            station: d3.greatest(stations, d => d.prcp),
            label: 'Wettest'
        }
    ].filter(a => a.station);

    annotationG = scatterSvg.append('g')
        .attr('class', 'annotations')
        .attr('pointer-events', 'none');

    annotationG.selectAll('.annotation')
        .data(annotations)
        .join('g')
        .attr('class', 'annotation')
        .each(function(a) {
            const g = d3.select(this);
            const x = xScale(a.station.tmax);
            const y = yScale(a.station.prcp);

            const isHottest = a.label === 'Hottest';
            const isColdest = a.label === 'Coldest';
            const isWettest = a.label === 'Wettest';
            let labelX, labelY, anchor = 'end', lineX, lineY;
            if (isHottest) {
                labelX = x + 55;
                labelY = y - 200;
                lineX = x - 15;
                lineY = labelY + 5;
            } 
            else if (isWettest) {
                labelX = x + 75;
                labelY = y + 20;
                lineX = x + 10;
                lineY = labelY - 5;
            } 
            else if (isColdest) {
                labelX = x + 190;
                labelY = y - 90;
                lineX = x + 80;
                lineY = labelY + 5;
            }

            g.append('line')
                .attr('x1', x)
                .attr('y1', y)
                .attr('x2', lineX)
                .attr('y2', lineY);


            g.append('text')
                .attr('x', labelX)
                .attr('y', labelY)
                .attr('text-anchor', anchor)
                .text(`${a.label}: ${a.station.station} (${a.station.state})`);
        });
}

function mapBrushed(event) {
    if (!event.sourceEvent) return; // ignore programmatic brush.move calls
    if (event.type === 'start') scatterBrushG.call(scatterBrush.move, null);
    selected = selectWithin(event.selection, d => mapTransform.apply(d.xy));
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
    } 
    else {
        d3.selectAll('.station').filter(d => selected.has(d.station)).raise()
        const picked = stations.filter(d => selected.has(d.station));
        const avgHigh = d3.mean(picked, d => d.tmax);
        const avgPrcp = d3.mean(picked, d => d.prcp);
        d3.select('#summary').text(picked.length === 0
            ? 'No stations selected.'
            : `${picked.length} stations selected: avg high ${avgHigh.toFixed(1)}°F, avg precipitation ${avgPrcp.toFixed(3)} in/day.`);
    }
    if (annotationG) {
        annotationG.raise();
    }
}

function showTooltip(event, d) {
    d3.selectAll('.station')
        .classed('hovered', s => s.station === d.station);

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
    d3.selectAll('.station')
        .classed('hovered', false);
}

function setSelection(names) {
    selected = names;

    mapBrushG.call(mapBrush.move, null);
    scatterBrushG.call(scatterBrush.move, null);

    updateHighlight();
}

function selectPercentile(property, percentile, above = true) {
    const sorted = stations
        .map(d => d[property])
        .sort(d3.ascending);

    const cutoff = d3.quantile(sorted, percentile);

    const names = stations
        .filter(d => above
            ? d[property] >= cutoff
            : d[property] <= cutoff)
        .map(d => d.station);

    setSelection(new Set(names));
}

function zoomed(event) {
    mapTransform = event.transform;

    mapStateLayer.attr('transform', mapTransform);
    mapDotLayer.attr('transform', mapTransform);

    mapDotLayer.selectAll('.station')
        .attr('r', 3 / mapTransform.k);

    mapBrushG.call(mapBrush.move, null);
}