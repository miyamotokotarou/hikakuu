(function(){
	"use strict";

	// Minimal utilities
	function el(tag, attrs={}, children=[]) {
		const node = document.createElement(tag);
		Object.entries(attrs).forEach(([k,v])=>{
			if(k === 'class') node.className = v;
			else if(k === 'html') node.innerHTML = v;
			else if(k.startsWith('on') && typeof v === 'function') node.addEventListener(k.substring(2), v);
			else node.setAttribute(k, v);
		});
		(children||[]).forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
		return node;
	}
	function download(filename, text){
		const blob = new Blob([text], {type:"text/csv;charset=utf-8;"});
		const url = URL.createObjectURL(blob);
		const a = el('a', {href:url, download:filename});
		document.body.appendChild(a); a.click(); a.remove();
		URL.revokeObjectURL(url);
	}

	const FIXED_QUESTIONS = 26;
	const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

	const quickResults = document.getElementById('quick-results');
	const photoExport = document.getElementById('photo-export');

	// OMR canvas helpers
	const omrCanvas = document.getElementById('omr-canvas');
	const omrCtx = omrCanvas.getContext('2d');
	async function loadImageToCanvas(file){
		return new Promise((resolve,reject)=>{
			const reader = new FileReader();
			reader.onload = () => {
				const img = new Image();
				img.onload = () => {
					const maxW = Math.min(1200, img.width);
					const scale = maxW / img.width;
					omrCanvas.width = Math.round(img.width * scale);
					omrCanvas.height = Math.round(img.height * scale);
					omrCtx.drawImage(img, 0, 0, omrCanvas.width, omrCanvas.height);
					resolve();
				};
				img.onerror = reject;
				img.src = reader.result;
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}
	function thresholdCanvas(th){
		const imgData = omrCtx.getImageData(0,0,omrCanvas.width, omrCanvas.height);
		const d = imgData.data;
		for(let i=0;i<d.length;i+=4){
			const g = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
			const v = g < th ? 0 : 255;
			d[i]=d[i+1]=d[i+2]=v;
		}
		omrCtx.putImageData(imgData,0,0);
	}
	function sampleCircleStats(cx, cy, r, emphasizeRing){
		const img = omrCtx.getImageData(Math.max(0,cx-r), Math.max(0,cy-r), r*2, r*2);
		let black = 0; let total = 0; const d = img.data; const rr = r*r; const inner = (r*0.55)*(r*0.55);
		for(let y=0; y<2*r; y++){
			for(let x=0; x<2*r; x++){
				const dx = x - r; const dy = y - r; const dist2 = dx*dx + dy*dy;
				if(dist2 <= rr){
					const idx = (y*(2*r) + x)*4; const v = d[idx];
					const weight = emphasizeRing ? (dist2 > inner ? 1.0 : 0.4) : 1.0;
					if(v === 0) black += weight;
					total += weight;
				}
			}
		}
		return { blackRatio: total ? (black/total) : 0 };
	}
	function detectAnswers({x,y,colW,rowH,radius,choices,fillPct,marginPct,mode,centerSearch,ring,forcePick}){
		const out = [];
		for(let qi=0; qi<FIXED_QUESTIONS; qi++){
			const ratios = [];
			for(let ci=0; ci<choices; ci++){
				let best = 0;
				for(let dx=-centerSearch; dx<=centerSearch; dx++){
					for(let dy=-centerSearch; dy<=centerSearch; dy++){
						const cx = Math.round(x + ci*colW + dx);
						const cy = Math.round(y + qi*rowH + dy);
						const {blackRatio} = sampleCircleStats(cx, cy, radius, ring);
						if(blackRatio > best) best = blackRatio;
					}
				}
				ratios.push(best);
			}
			const maxR = Math.max(...ratios);
			const bestIdx = ratios.indexOf(maxR);
			if(mode === 'relative'){
				const ambiguous = ratios.some((r,i)=> i!==bestIdx && (maxR - r) <= (marginPct/100));
				out.push((ambiguous && !forcePick) ? '' : ABC[bestIdx]);
				continue;
			}
			const minAccept = (fillPct/100);
			if(maxR < minAccept){ out.push(''); continue; }
			const ambiguous = ratios.some((r,i)=> i!==bestIdx && (maxR - r) <= (marginPct/100));
			out.push((ambiguous && !forcePick) ? '' : ABC[bestIdx]);
		}
		return out;
	}
	function readOmrParams(){
		return {
			x: Number(document.getElementById('omr-x')?.value||0),
			y: Number(document.getElementById('omr-y')?.value||0),
			colW: Number(document.getElementById('omr-colw')?.value||48),
			rowH: Number(document.getElementById('omr-rowh')?.value||36),
			radius: Number(document.getElementById('omr-r')?.value||12),
			th: Number(document.getElementById('omr-th')?.value||140),
			choices: Number(document.getElementById('omr-c')?.value||5),
			fillPct: Number(document.getElementById('omr-fill')?.value||35),
			marginPct: Number(document.getElementById('omr-margin')?.value||10),
			mode: String(document.getElementById('omr-mode')?.value||'absolute'),
			centerSearch: Number(document.getElementById('omr-center')?.value||0),
			ring: Boolean(document.getElementById('omr-ring')?.checked),
			forcePick: Boolean(document.getElementById('omr-force')?.checked)
		};
	}

	// presets
	const presetSel = document.getElementById('omr-preset');
	function applyPreset(preset){
		const th = document.getElementById('omr-th');
		const fill = document.getElementById('omr-fill');
		const margin = document.getElementById('omr-margin');
		switch(preset){
			case 'lenient':
				th.value = String(Math.max(120, Number(th.value)||140));
				fill.value = '25';
				margin.value = '20';
				break;
			case 'strict':
				th.value = String(Math.min(200, Number(th.value)||140));
				fill.value = '60';
				margin.value = '5';
				break;
			default:
				th.value = '140';
				fill.value = '35';
				margin.value = '10';
		}
	}
	presetSel?.addEventListener('change', (e)=> applyPreset(e.target.value));

	// Photo-only grading state
	let keyAnswers = [];
	let gradedRows = [];

	document.getElementById('omr-key-detect')?.addEventListener('click', async () => {
		const file = document.getElementById('omr-key-img')?.files?.[0];
		if(!file){ alert('キー画像を選択してください。'); return; }
		const p = readOmrParams();
		await loadImageToCanvas(file);
		thresholdCanvas(p.th);
		keyAnswers = detectAnswers(p);
		if(keyAnswers.length !== FIXED_QUESTIONS){ alert(`キー検出は${FIXED_QUESTIONS}問になるようにパラメータを調整してください。`); return; }
		alert('キーを読み取りました。回答画像を読み込んでください。');
	});

	document.getElementById('omr-resp-detect')?.addEventListener('click', async () => {
		if(!keyAnswers.length){ alert('先にキー画像を検出してください。'); return; }
		const file = document.getElementById('omr-resp-img')?.files?.[0];
		if(!file){ alert('回答画像を選択してください。'); return; }
		const p = readOmrParams();
		await loadImageToCanvas(file);
		thresholdCanvas(p.th);
		const answers = detectAnswers(p);
		let total=0; for(let i=0;i<FIXED_QUESTIONS;i++){ if((answers[i]||'') === (keyAnswers[i]||'')) total++; }
		const row = { id:'', name:'', total, max: FIXED_QUESTIONS, percent: Math.round((total/FIXED_QUESTIONS)*1000)/10 };
		gradedRows.push(row);
		renderResults();
	});

	function renderResults(){
		if(!gradedRows.length){ quickResults.innerHTML = '<p>結果がありません。</p>'; return; }
		const table = el('table', {class:'grid'});
		const thead = el('thead');
		const trh = el('tr');
		['#','得点','満点','割合(%)'].forEach(h=> trh.appendChild(el('th',{},[h])));
		thead.appendChild(trh); table.appendChild(thead);
		const tbody = el('tbody');
		gradedRows.forEach((r, i)=>{
			const tr = el('tr');
			tr.appendChild(el('td',{},[String(i+1)]));
			tr.appendChild(el('td',{},[String(r.total)]));
			tr.appendChild(el('td',{},[String(r.max)]));
			tr.appendChild(el('td',{},[String(r.percent)]));
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		quickResults.innerHTML = '';
		quickResults.appendChild(table);
	}

	photoExport?.addEventListener('click', ()=>{
		if(!gradedRows.length){ alert('先に採点してください。'); return; }
		const header = ['index','score','max','percent'];
		const lines = [header.join(',')];
		gradedRows.forEach((r,i)=> lines.push([i+1,r.total,r.max,r.percent].join(',')));
		download('photo_results.csv', lines.join('\n'));
	});

})(); 
