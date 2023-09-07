'use client'

import { Slot } from '@radix-ui/react-slot'
import { ChainId } from '@sushiswap/chain'
import { DataTable } from '@sushiswap/ui'
import { ColumnDef, PaginationState } from '@tanstack/react-table'
import { Row } from '@tanstack/react-table'
import React, { FC, ReactNode, useCallback, useState } from 'react'
import { Address } from 'wagmi'

import { STEER_NAME_COLUMN, STEER_POSITION_SIZE_COLUMN, STEER_STRATEGY_COLUMN } from './columns'
import { SteerPosition, useSteerPositions } from './useSteerPositions'

const COLUMNS = [STEER_NAME_COLUMN, STEER_STRATEGY_COLUMN, STEER_POSITION_SIZE_COLUMN] satisfies ColumnDef<
  SteerPosition,
  unknown
>[]

const tableState = { sorting: [{ id: 'positionSize', desc: true }] }

interface Smart {
  chainId?: ChainId
  poolAddress?: Address
  onRowClick?(row: SteerPosition): void
}

export const Smart: FC<Smart> = ({ chainId, poolAddress, onRowClick }) => {
  const [paginationState, setPaginationState] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  })

  const rowRenderer = useCallback(
    (row: Row<SteerPosition>, rowNode: ReactNode) => {
      if (onRowClick)
        return (
          <Slot className="cursor-pointer" onClick={() => onRowClick?.(row.original)}>
            {rowNode}
          </Slot>
        )
      return rowNode
    },
    [onRowClick]
  )

  const { data, isLoading } = useSteerPositions({ chainId, poolAddress })

  return (
    <DataTable
      testId="concentrated-smart-positions"
      loading={isLoading}
      linkFormatter={(row) => `/pool/${row.vault.pool.id}/smart/${row.vault.id}`}
      rowRenderer={rowRenderer}
      columns={COLUMNS}
      data={data}
      pagination={true}
      onPaginationChange={setPaginationState}
      state={{
        ...tableState,
        pagination: paginationState,
      }}
    />
  )
}
