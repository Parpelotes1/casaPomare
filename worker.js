// Casa Pomarê — Backend Cloudflare Worker
// Leitura publica do catalogo; escrita somente com token de administrador.

const TZ = 'America/Sao_Paulo';

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'Content-Type, Authorization';

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(dados, status, request) {
  const headers = corsHeaders(request);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify(dados), { status: status || 200, headers });
}

// Comparacao de tempo constante simples, para nao vazar o token por timing.
function tokenValido(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const esperado = 'Bearer ' + (env.ADMIN_TOKEN || '');
  if (auth.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < auth.length; i++) {
    diff |= auth.charCodeAt(i) ^ esperado.charCodeAt(i);
  }
  return diff === 0;
}

// Converte data local de Sao Paulo em partes utilizaveis.
function agoraLocal() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const partes = fmt.formatToParts(new Date());
  const mapa = {};
  for (const p of partes) mapa[p.type] = p.value;
  const dias = { Sun: 'dom', Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex', Sat: 'sab' };
  const ordem = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const dia = dias[mapa.weekday];
  const idx = ordem.indexOf(dia);
  const anterior = ordem[(idx + 6) % 7];
  const hora = parseInt(mapa.hour, 10) % 24;
  const minuto = parseInt(mapa.minute, 10);
  return { dia: dia, anterior: anterior, minutos: hora * 60 + minuto, horaStr: String(hora).padStart(2, '0') + ':' + String(minuto).padStart(2, '0') };
}

function paraMinutos(hhmm) {
  if (!hhmm) return null;
  const p = String(hhmm).split(':');
  if (p.length !== 2) return null;
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

// Calcula se a loja esta aberta.
// Precedencia: ajuste manual vigente -> horario semanal.
// Fechamento e exclusivo: no minuto exato do fechamento, ja esta fechada.
// Horario que atravessa a meia-noite (fim < inicio) e tratado verificando
// tambem a programacao do dia anterior.
function calcularStatus(config) {
  const agora = agoraLocal();

  if (config.modo === 'aberto_manual' || config.modo === 'fechado_manual') {
    const expira = config.manual_expira ? new Date(config.manual_expira).getTime() : 0;
    if (expira && Date.now() < expira) {
      const aberta = config.modo === 'aberto_manual';
      return {
        aberta: aberta,
        motivo: aberta ? 'Ajuste manual: aberta' : 'Ajuste manual: fechada',
        proxima_abertura: null
      };
    }
  }

  const horarios = config.horarios || {};
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const nomes = { dom: 'domingo', seg: 'segunda', ter: 'terca', qua: 'quarta', qui: 'quinta', sex: 'sexta', sab: 'sabado' };

  function intervaloDoDia(chave) {
    const h = horarios[chave];
    if (!h || !h.aberto) return null;
    const ini = paraMinutos(h.ini);
    const fim = paraMinutos(h.fim);
    if (ini === null || fim === null) return null;
    return { ini: ini, fim: fim, atravessa: fim <= ini };
  }

  const hoje = intervaloDoDia(agora.dia);
  if (hoje) {
    if (!hoje.atravessa) {
      if (agora.minutos >= hoje.ini && agora.minutos < hoje.fim) {
        return { aberta: true, motivo: 'Dentro do horario de funcionamento', proxima_abertura: null };
      }
    } else {
      if (agora.minutos >= hoje.ini) {
        return { aberta: true, motivo: 'Dentro do horario de funcionamento', proxima_abertura: null };
      }
    }
  }

  const ontem = intervaloDoDia(agora.anterior);
  if (ontem && ontem.atravessa && agora.minutos < ontem.fim) {
    return { aberta: true, motivo: 'Dentro do horario de funcionamento', proxima_abertura: null };
  }

  // Procura a proxima abertura nos proximos 7 dias.
  for (let i = 0; i < 8; i++) {
    const chave = dias[(dias.indexOf(agora.dia) + i) % 7];
    const iv = intervaloDoDia(chave);
    if (!iv) continue;
    if (i === 0 && agora.minutos >= iv.ini) continue;
    const quando = i === 0 ? 'hoje' : (i === 1 ? 'amanha' : nomes[chave]);
    return {
      aberta: false,
      motivo: 'Fora do horario de funcionamento',
      proxima_abertura: quando + ' as ' + horarios[chave].ini
    };
  }

  return { aberta: false, motivo: 'Sem horario configurado', proxima_abertura: null };
}

async function lerConfig(env) {
  const { results } = await env.DB.prepare('SELECT chave, valor FROM config').all();
  const obj = {};
  for (const linha of results) {
    try { obj[linha.chave] = JSON.parse(linha.valor); }
    catch (e) { obj[linha.chave] = linha.valor; }
  }
  return obj;
}

async function lerProdutos(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, nome, descricao, preco, categoria, disponivel, imagem_url FROM produtos ORDER BY nome ASC'
  ).all();
  return results.map(function (p) {
    return {
      id: p.id,
      nome: p.nome,
      descricao: p.descricao,
      preco: p.preco,
      categoria: p.categoria,
      disponivel: !!p.disponivel,
      imagem_url: p.imagem_url
    };
  });
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);
      const caminho = url.pathname;
      const metodo = request.method;

      // ---------- PUBLICO ----------

      if (caminho === '/api/public/catalogo' && metodo === 'GET') {
        const produtos = await lerProdutos(env);
        const config = await lerConfig(env);
        const loja = calcularStatus(config);
        const resp = json({ produtos: produtos, config: config, loja: loja }, 200, request);
        resp.headers.set('Cache-Control', 'no-cache');
        return resp;
      }

      if (caminho.startsWith('/api/imagem/') && metodo === 'GET') {
        const nome = decodeURIComponent(caminho.replace('/api/imagem/', ''));
        if (!nome) return json({ erro: 'Nome ausente' }, 400, request);
        const obj = await env.BUCKET.get(nome);
        if (!obj) return json({ erro: 'Imagem nao encontrada' }, 404, request);
        const headers = {
          'Content-Type': obj.httpMetadata ? obj.httpMetadata.contentType : 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable'
        };
        return new Response(obj.body, { status: 200, headers: headers });
      }

      // ---------- A PARTIR DAQUI, EXIGE TOKEN ----------

      if (!tokenValido(request, env)) {
        return json({ erro: 'Nao autorizado' }, 401, request);
      }

      if (caminho === '/api/produtos' && metodo === 'GET') {
        const produtos = await lerProdutos(env);
        return json({ produtos: produtos }, 200, request);
      }

      if (caminho === '/api/produtos' && metodo === 'POST') {
        const corpo = await request.json();
        const nome = (corpo.nome || '').trim();
        const preco = Number(corpo.preco);
        if (!nome) return json({ erro: 'Nome e obrigatorio' }, 400, request);
        if (!(preco > 0)) return json({ erro: 'Preco deve ser maior que zero' }, 400, request);

        const id = crypto.randomUUID();
        const agora = new Date().toISOString();
        await env.DB.prepare(
          'INSERT INTO produtos (id, nome, descricao, preco, categoria, disponivel, imagem_url, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          id,
          nome,
          corpo.descricao || '',
          preco,
          corpo.categoria || 'outros',
          corpo.disponivel === false ? 0 : 1,
          corpo.imagem_url || '',
          agora,
          agora
        ).run();

        return json({ id: id, nome: nome, descricao: corpo.descricao || '', preco: preco, categoria: corpo.categoria || 'outros', disponivel: corpo.disponivel !== false, imagem_url: corpo.imagem_url || '' }, 201, request);
      }

      const matchProduto = caminho.match(/^\/api\/produtos\/([^/]+)$/);

      if (matchProduto && metodo === 'PUT') {
        const id = matchProduto[1];
        const corpo = await request.json();
        const nome = (corpo.nome || '').trim();
        const preco = Number(corpo.preco);
        if (!nome) return json({ erro: 'Nome e obrigatorio' }, 400, request);
        if (!(preco > 0)) return json({ erro: 'Preco deve ser maior que zero' }, 400, request);

        const r = await env.DB.prepare(
          'UPDATE produtos SET nome = ?, descricao = ?, preco = ?, categoria = ?, disponivel = ?, imagem_url = ?, atualizado_em = ? WHERE id = ?'
        ).bind(
          nome,
          corpo.descricao || '',
          preco,
          corpo.categoria || 'outros',
          corpo.disponivel === false ? 0 : 1,
          corpo.imagem_url || '',
          new Date().toISOString(),
          id
        ).run();

        if (r.meta && r.meta.changes === 0) return json({ erro: 'Produto nao encontrado' }, 404, request);
        return json({ ok: true, id: id }, 200, request);
      }

      if (matchProduto && metodo === 'PATCH') {
        const id = matchProduto[1];
        const corpo = await request.json();
        const disponivel = corpo.disponivel ? 1 : 0;
        const r = await env.DB.prepare(
          'UPDATE produtos SET disponivel = ?, atualizado_em = ? WHERE id = ?'
        ).bind(disponivel, new Date().toISOString(), id).run();
        if (r.meta && r.meta.changes === 0) return json({ erro: 'Produto nao encontrado' }, 404, request);
        return json({ ok: true, disponivel: !!disponivel }, 200, request);
      }

      if (matchProduto && metodo === 'DELETE') {
        const id = matchProduto[1];
        await env.DB.prepare('DELETE FROM produtos WHERE id = ?').bind(id).run();
        return new Response(null, { status: 204, headers: cors });
      }

      if (caminho === '/api/config' && metodo === 'GET') {
        const config = await lerConfig(env);
        return json(config, 200, request);
      }

      if (caminho === '/api/config' && metodo === 'PUT') {
        const corpo = await request.json();
        const agora = new Date().toISOString();
        const stmts = [];
        for (const chave in corpo) {
          if (!Object.prototype.hasOwnProperty.call(corpo, chave)) continue;
          stmts.push(
            env.DB.prepare('INSERT OR REPLACE INTO config (chave, valor, atualizado_em) VALUES (?, ?, ?)')
              .bind(chave, JSON.stringify(corpo[chave]), agora)
          );
        }
        if (stmts.length) await env.DB.batch(stmts);
        return json({ ok: true, gravadas: stmts.length }, 200, request);
      }

      if (caminho === '/api/upload' && metodo === 'POST') {
        const form = await request.formData();
        const arquivo = form.get('arquivo');
        if (!arquivo || typeof arquivo === 'string') {
          return json({ erro: 'Arquivo ausente' }, 400, request);
        }
        if (!arquivo.type || arquivo.type.indexOf('image/') !== 0) {
          return json({ erro: 'Somente imagens sao aceitas' }, 400, request);
        }
        if (arquivo.size > 4 * 1024 * 1024) {
          return json({ erro: 'Imagem maior que 4 MB' }, 400, request);
        }

        const ext = arquivo.type === 'image/png' ? 'png'
          : arquivo.type === 'image/webp' ? 'webp'
          : arquivo.type === 'image/gif' ? 'gif'
          : 'jpg';
        const nome = crypto.randomUUID() + '.' + ext;

        await env.BUCKET.put(nome, arquivo.stream(), {
          httpMetadata: { contentType: arquivo.type }
        });

        return json({ url: '/api/imagem/' + nome }, 201, request);
      }

      return json({ erro: 'Rota nao encontrada' }, 404, request);

    } catch (err) {
      console.error('Erro no worker:', err && err.stack ? err.stack : err);
      return json({ erro: 'Erro interno' }, 500, request);
    }
  }
};
