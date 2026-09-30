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
create index if not exists
