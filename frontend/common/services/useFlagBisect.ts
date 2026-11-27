import { Res } from 'common/types/responses'
import { Req } from 'common/types/requests'
import { service } from 'common/service'

const invalidate = (incidentId: number) => [
  { id: incidentId, type: 'FlagBisectIncident' as const },
  { id: 'LIST', type: 'FlagBisectIncident' as const },
]

export const flagBisectService = service
  .enhanceEndpoints({ addTagTypes: ['FlagBisectIncident'] })
  .injectEndpoints({
    endpoints: (builder) => ({
      abortFlagBisectIncident: builder.mutation<
        Res['flagBisectIncident'],
        Req['abortFlagBisectIncident']
      >({
        invalidatesTags: (_res, _err, { incidentId }) => invalidate(incidentId),
        query: ({ body, environmentId, incidentId }) => ({
          body,
          method: 'POST',
          url: `environments/${environmentId}/flag-bisect/incidents/${incidentId}/abort/`,
        }),
      }),
      approveFlagBisectEnvelope: builder.mutation<
        Res['flagBisectIncident'],
        Req['approveFlagBisectEnvelope']
      >({
        invalidatesTags: (_res, _err, { incidentId }) => invalidate(incidentId),
        query: ({ body, environmentId, incidentId }) => ({
          body,
          method: 'POST',
          url: `environments/${environmentId}/flag-bisect/incidents/${incidentId}/approve-envelope/`,
        }),
      }),
      flagBisectRemediation: builder.mutation<
        Res['flagBisectIncident'],
        Req['flagBisectRemediation']
      >({
        invalidatesTags: (_res, _err, { incidentId }) => invalidate(incidentId),
        query: ({ action, environmentId, incidentId }) => ({
          method: 'POST',
          url: `environments/${environmentId}/flag-bisect/incidents/${incidentId}/${action}-remediation/`,
        }),
      }),
      getFlagBisectIncident: builder.query<
        Res['flagBisectIncident'],
        Req['getFlagBisectIncident']
      >({
        providesTags: (_res, _err, { incidentId }) => [
          { id: incidentId, type: 'FlagBisectIncident' },
        ],
        query: ({ environmentId, incidentId }) => ({
          url: `environments/${environmentId}/flag-bisect/incidents/${incidentId}/`,
        }),
      }),
      getFlagBisectIncidents: builder.query<
        Res['flagBisectIncidents'],
        Req['getFlagBisectIncidents']
      >({
        providesTags: [{ id: 'LIST', type: 'FlagBisectIncident' }],
        query: ({ environmentId }) => ({
          url: `environments/${environmentId}/flag-bisect/incidents/`,
        }),
      }),
    }),
  })

export const {
  useAbortFlagBisectIncidentMutation,
  useApproveFlagBisectEnvelopeMutation,
  useFlagBisectRemediationMutation,
  useGetFlagBisectIncidentQuery,
  useGetFlagBisectIncidentsQuery,
} = flagBisectService
