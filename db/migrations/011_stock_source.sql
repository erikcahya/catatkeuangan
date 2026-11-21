-- Saham BEI sebagai sumber harga pasar (per lembar) di samping kripto, emas, dan valas.
alter table savings_holding drop constraint savings_holding_price_source_check;
alter table savings_holding add constraint savings_holding_price_source_check
  check (price_source is null or price_source in ('crypto','gold','fx','stock'));
