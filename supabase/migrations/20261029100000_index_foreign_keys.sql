-- Indexes for the foreign keys the performance advisor found without one
-- (unindexed_foreign_keys). Without them, deleting a form, a user or a stop has to
-- scan the referencing table, and filtering flights by form or creator can't use an index.

create index flights_form_id_idx on public.flights (form_id);
create index flights_created_by_idx on public.flights (created_by);
create index reports_created_by_idx on public.reports (created_by);
-- matches the composite foreign key (stop_id, flight_id) -> flight_stops (id, flight_id)
create index zone_allocations_stop_flight_idx on public.zone_allocations (stop_id, flight_id);
