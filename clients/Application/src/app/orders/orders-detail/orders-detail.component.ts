/*
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Observable } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { ServiceHelperService } from '../../service-helper.service';
import { Order } from '../models/order.interface';
import { OrderProduct } from '../models/orderproduct.interface';
import { OrdersService } from '../orders.service';

@Component({
  selector: 'app-orders-detail',
  templateUrl: './orders-detail.component.html',
  styleUrls: [ './orders-detail.component.scss'  ]
})
export class OrdersDetailComponent implements OnInit {
  tenantId$: Observable<string>;
  orderId$: Observable<string>;
  order$: Observable<Order>;
  orderProducts$: Observable<OrderProduct[]>;
  taxRate = .0899;
  constructor(private route: ActivatedRoute,
              private orderSvc: OrdersService,
              private helperSvc: ServiceHelperService) { }

  ngOnInit(): void {
    this.tenantId$ = this.route.paramMap.pipe(
      map(p => p.get("tenantId"))
    );
    
    this.orderId$ = this.route.params.pipe(
      map(o => o.orderId)
    );

    this.order$ = this.orderId$.pipe(
      switchMap(o => this.orderSvc.get(o))
    );

    this.orderProducts$ = this.order$.pipe(
      map(o => o.orderProduct)
    )
  }

  today() {
    return new Date();
  }

  sum(op: OrderProduct) {
    return op.price * op.quantity;
  }

  tax(op: OrderProduct) {
    return this.sum(op) * this.taxRate;
  }

  total(op: OrderProduct) {
    return this.sum(op) + this.tax(op);
  }

  subTotal(order: Order) {
    return order.orderProduct
      .map(op => op.price * op.quantity)
      .reduce((acc, curr) => acc + curr);
  }

  calcTax(order: Order) {
    return this.subTotal(order) * this.taxRate;
  }

  final(order: Order) {
    return this.subTotal(order) + this.calcTax(order);
  }


}
