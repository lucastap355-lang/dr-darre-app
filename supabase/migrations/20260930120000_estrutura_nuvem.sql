-- DR Darre · estrutura da nuvem.
create table if not exists public.produtos (
  id uuid primary key, codigo text not null, tipo text, descricao text, tamanho text, cor text,
  preco numeric(12,2) not null default 0, custo numeric(12,2), qtd integer not null default 0,
  estoque_min integer not null default 2, deleted boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.ajustes (
  id uuid primary key, produto_id uuid not null references public.produtos(id), delta integer not null,
  motivo text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.vendas (
  id uuid primary key, numero text, data timestamptz not null default now(), itens jsonb not null default '[]',
  subtotal numeric(12,2) default 0, desconto numeric(12,2) default 0, desconto_tipo text, total numeric(12,2) default 0,
  forma text, parcelas integer default 1, recebido numeric(12,2), troco numeric(12,2), cliente_nome text, cliente_tel text,
  cancelada boolean not null default false, baixa_estoque boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.config (id text primary key, valor jsonb not null default '{}', updated_at timestamptz not null default now());
create index if not exists produtos_upd on public.produtos(updated_at);
create index if not exists vendas_upd on public.vendas(updated_at);
create index if not exists vendas_data on public.vendas(data);
-- versão 3.3: vendedora nas vendas e detalhes das movimentações (devoluções). Pode rodar de novo sem problema.
alter table public.vendas add column if not exists vendedor text;
alter table public.ajustes add column if not exists tipo text;
alter table public.ajustes add column if not exists venda_id uuid;
alter table public.ajustes add column if not exists cliente text;
alter table public.ajustes add column if not exists vendedor text;
alter table public.ajustes add column if not exists valor numeric(12,2);
create index if not exists ajustes_upd on public.ajustes(updated_at);
-- carimbo de alteração (usado na sincronização)
create or replace function public.prd_upd() returns trigger language plpgsql as $$
begin new.updated_at := clock_timestamp(); return new; end $$;
do $$ declare t text; begin foreach t in array array['produtos','ajustes','vendas','config'] loop
  execute format('drop trigger if exists %I_upd on public.%I', t, t);
  execute format('create trigger %I_upd before insert or update on public.%I for each row execute function public.prd_upd()', t, t);
end loop; end $$;
-- estoque: entradas e ajustes somam, vendas descontam, cancelamentos devolvem
create or replace function public.prd_ajuste() returns trigger language plpgsql as $$
begin update public.produtos set qtd = qtd + new.delta where id = new.produto_id; return new; end $$;
drop trigger if exists ajustes_estoque on public.ajustes;
create trigger ajustes_estoque after insert on public.ajustes for each row execute function public.prd_ajuste();
create or replace function public.prd_venda() returns trigger language plpgsql as $$
declare it jsonb; s int := 0;
begin
  if tg_op = 'INSERT' then
    if not new.cancelada and new.baixa_estoque then s := -1; end if;
  elsif new.cancelada and not old.cancelada then s := 1;
  elsif old.cancelada and not new.cancelada then s := -1;
  end if;
  if s <> 0 then
    for it in select * from jsonb_array_elements(new.itens) loop
      if it ? 'produto_id' and (it->>'produto_id') is not null then
        update public.produtos set qtd = qtd + s * coalesce((it->>'qtd')::int, 1) where id = (it->>'produto_id')::uuid;
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists vendas_estoque on public.vendas;
create trigger vendas_estoque after insert or update of cancelada on public.vendas for each row execute function public.prd_venda();
-- segurança: só usuários logados da loja acessam
do $$ declare t text; begin foreach t in array array['produtos','ajustes','vendas','config'] loop
  execute format('alter table public.%I enable row level security', t);
  execute format('drop policy if exists equipe on public.%I', t);
  execute format('create policy equipe on public.%I for all to authenticated using (true) with check (true)', t);
  execute format('grant select, insert, update, delete on public.%I to authenticated', t);
end loop; end $$;
notify pgrst, 'reload schema';
