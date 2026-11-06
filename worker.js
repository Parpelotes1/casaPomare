const SQL_NOW = "datetime('now')";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization",
    };

    const json = (data, status) => {
      const s = status || 200;
      return new Response(JSON.stringify(data), {
        status: s,
        headers: {
          ...cors,
          "Content-Type": "application/json;charset=UTF-8",
        },
      });
    };

    const erro = (msg, status) => {
      return json({ ok: false, erro: msg }, status || 400);
    };

    const authOk = (req) => {
      const h = req.headers.get("Authorization");
      const esperado = "Bearer " + env.ADMIN_TOKEN;
      return h === esperado;
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {
      if (path === "/api/produtos") {
        const sql =
          "SELECT * FROM produtos " +
          "WHERE ativo = 1 " +
          "ORDER BY ordem ASC, id ASC";
        const r = await env.DB.prepare(sql).all();
        return json(r.results);
      }

      if (path === "/api/config") {
        const sql = "SELECT chave, valor FROM config";
        const r = await env.DB.prepare(sql).all();
        const obj = {};
        const linhas = r.results || [];
        for (const linha of linhas) {
          obj[linha.chave] = linha.valor;
        }
        return json(obj);
      }

      if (path === "/api/pedido" && request.method === "POST") {
        const b = await request.json();
        const itens = b.itens;
        if (!Array.isArray(itens) || itens.length === 0) {
          return erro("O pedido precisa ter pelo menos um item.");
        }
        let total = 0;
        for (const i of itens) {
          const p = Number(i.preco_centavos) || 0;
          const q = Number(i.qtd) || 0;
          total = total + p * q;
        }
        const sql =
          "INSERT INTO pedidos (" +
          "cliente_nome, cliente_telefone, tipo_entrega, " +
          "endereco, observacoes, itens_json, total_centavos" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?)";
        const r = await env.DB.prepare(sql)
          .bind(
            b.cliente_nome || null,
            b.cliente_telefone || null,
            b.tipo_entrega || "entrega",
            b.endereco || null,
            b.observacoes || null,
            JSON.stringify(itens),
            total
          )
          .run();
        const id = r.meta.last_row_id;
        return json({ ok: true, id: id, total_centavos: total });
      }

      if (path === "/api/pedidos") {
        const sql =
          "SELECT * FROM pedidos ORDER BY id DESC LIMIT 200";
        const r = await env.DB.prepare(sql).all();
        return json(r.results);
      }

      if (path.indexOf("/api/admin/") === 0) {
        if (!authOk(request)) {
          return erro("Token invalido ou ausente.", 401);
        }

        if (path === "/api/admin/pedidos") {
          const sql =
            "SELECT * FROM pedidos ORDER BY id DESC LIMIT 200";
          const r = await env.DB.prepare(sql).all();
          return json(r.results);
        }

        const pedMatch = path.match(
          /^\/api\/admin\/pedidos\/(\d+)$/
        );
        if (pedMatch && request.method === "PATCH") {
          const b = await request.json();
          const status = String(b.status || "").trim();
          const validos = [
            "novo",
            "em_preparo",
            "entregue",
            "cancelado",
          ];
          if (!validos.includes(status)) {
            return erro("Status invalido.");
          }
          const sql =
            "UPDATE pedidos SET status = ? WHERE id = ?";
          await env.DB.prepare(sql)
            .bind(status, Number(pedMatch[1]))
            .run();
          return json({ ok: true });
        }

        if (path === "/api/admin/backup") {
          const sp = "SELECT * FROM produtos ORDER BY id ASC";
          const sc = "SELECT chave, valor FROM config";
          const sd = "SELECT * FROM pedidos ORDER BY id ASC";
          const prod = await env.DB.prepare(sp).all();
          const conf = await env.DB.prepare(sc).all();
          const ped = await env.DB.prepare(sd).all();
          return json({
            ok: true,
            gerado_em: new Date().toISOString(),
            versao: 1,
            produtos: prod.results,
            config: conf.results,
            pedidos: ped.results,
          });
        }

        if (
          path === "/api/admin/upload" &&
          request.method === "POST"
        ) {
          const form = await request.formData();
          const arq = form.get("imagem");
          if (!arq || typeof arq === "string") {
            return erro("Nenhuma imagem enviada.");
          }
          if (arq.type.indexOf("image/") !== 0) {
            return erro("O arquivo precisa ser uma imagem.");
          }
          const cincoMB = 5 * 1024 * 1024;
          if (arq.size > cincoMB) {
            return erro("A imagem pode ter no maximo 5 MB.");
          }
          const partes = arq.name.split(".");
          const ext = (partes.pop() || "jpg").toLowerCase();
          const rnd = Math.random().toString(36).slice(2, 8);
          const key = "produtos/" + Date.now() + "-" + rnd;
          const keyFinal = key + "." + ext;
          await env.BUCKET.put(keyFinal, arq.stream(), {
            httpMetadata: { contentType: arq.type },
          });
          const base = env.R2_PUBLIC_URL.replace(/\/$/, "");
          const urlFinal = base + "/" + keyFinal;
          return json(
            { ok: true, key: keyFinal, url: urlFinal },
            201
          );
        }

        if (path === "/api/admin/produtos") {
          if (request.method === "GET") {
            const sql =
              "SELECT * FROM produtos " +
              "ORDER BY ordem ASC, id ASC";
            const r = await env.DB.prepare(sql).all();
            return json(r.results);
          }
          if (request.method === "POST") {
            const b = await request.json();
            if (!b.nome) {
              return erro("O nome do produto e obrigatorio.");
            }
            const sql =
              "INSERT INTO produtos (" +
              "nome, descricao, preco_centavos, categoria, " +
              "imagem_url, ativo, ordem" +
              ") VALUES (?, ?, ?, ?, ?, ?, ?)";
            const ativo = b.ativo === false ? 0 : 1;
            const r = await env.DB.prepare(sql)
              .bind(
                b.nome,
                b.descricao || null,
                Number(b.preco_centavos) || 0,
                b.categoria || "Outros",
                b.imagem_url || null,
                ativo,
                Number(b.ordem) || 0
              )
              .run();
            return json({ ok: true, id: r.meta.last_row_id }, 201);
          }
        }

        const prodMatch = path.match(
          /^\/api\/admin\/produtos\/(\d+)$/
        );
        if (prodMatch) {
          const id = Number(prodMatch[1]);

          if (request.method === "PUT") {
            const b = await request.json();
            const partes = [
              "UPDATE produtos SET",
              "nome = COALESCE(?, nome),",
              "descricao = COALESCE(?, descricao),",
              "preco_centavos = COALESCE(?, preco_centavos),",
              "categoria = COALESCE(?, categoria),",
              "imagem_url = COALESCE(?, imagem_url),",
              "ativo = COALESCE(?, ativo),",
              "ordem = COALESCE(?, ordem),",
              "atualizado_em = " + SQL_NOW,
              "WHERE id = ?",
            ];
            const sql = partes.join(" ");
            let ativo = null;
            if (b.ativo !== undefined) {
              ativo = b.ativo ? 1 : 0;
            }
            await env.DB.prepare(sql)
              .bind(
                b.nome || null,
                b.descricao || null,
                b.preco_centavos || null,
                b.categoria || null,
                b.imagem_url || null,
                ativo,
                b.ordem || null,
                id
              )
              .run();
            return json({ ok: true });
          }

          if (request.method === "DELETE") {
            const sql =
              "SELECT imagem_url FROM produtos WHERE id = ?";
            const r = await env.DB.prepare(sql)
              .bind(id)
              .all();
            const linhas = r.results || [];
            if (linhas.length > 0) {
              const img = linhas[0].imagem_url;
              const base = env.R2_PUBLIC_URL.replace(/\/$/, "");
              if (img && img.indexOf(base) === 0) {
                const key = img.slice(base.length + 1);
                await env.BUCKET.delete(key);
              }
            }
            const del = "DELETE FROM produtos WHERE id = ?";
            await env.DB.prepare(del).bind(id).run();
            return json({ ok: true });
          }
        }

        if (
          path === "/api/admin/config" &&
          request.method === "PATCH"
        ) {
          const b = await request.json();
          const entradas = Object.entries(b);
          if (entradas.length === 0) {
            return erro("Nenhuma configuracao enviada.");
          }
          const partes = [
            "INSERT INTO config (chave, valor, atualizado_em)",
            "VALUES (?, ?, " + SQL_NOW + ")",
            "ON CONFLICT(chave) DO UPDATE SET",
            "valor = excluded.valor,",
            "atualizado_em = " + SQL_NOW,
          ];
          const sql = partes.join(" ");
          for (const par of entradas) {
            const chave = par[0];
            const valor = par[1];
            await env.DB.prepare(sql)
              .bind(chave, String(valor))
              .run();
          }
          return json({ ok: true });
        }

        return erro("Rota de admin nao encontrada.", 404);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response("Arquivo nao encontrado", {
        status: 404,
      });
    } catch (e) {
      const msg = "Erro interno: " + e.message;
      return erro(msg, 500);
    }
  },
};
